//! euler-tui — industrial-grade ratatui frontend for the Euler agent.
//!
//! Spawns the TS headless agent (`bun src/headless.ts`) as a subprocess, drives
//! it over the line-JSON bridge protocol, and renders the streaming events in a
//! ratatui interface. The agent logic (coordinator, 18 tools, context mgmt)
//! lives entirely in the TS subprocess — this binary is pure frontend.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{Event as CrosstermEvent, EventStream, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::app::App;
use crate::bridge::Bridge;
use crate::protocol::{AgentMessage, InitializeConfig};
use crate::ui::draw;

mod app;
mod bridge;
mod protocol;
mod ui;

/// Internal events on the main loop's select.
enum AppEvent {
    Key(KeyEvent),
    Bridge(AgentMessage),
    /// Periodic tick (spinner animation + non-blocking checks).
    Tick,
}

/// Resolved startup configuration: provider + model + optional explicit
/// credentials (from --api-key/--base-url) + a flag the agent should resume.
#[derive(Clone)]
struct Startup {
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
    resume: bool,
}

/// Mirrors the PROVIDERS map in src/agent/model/provider-config.ts so the TUI
/// can pick a provider from whatever env var happens to be set. The order is a
/// rough "popular first" preference. Keep in sync with that file.
fn provider_env_var(provider: &str) -> Option<&'static str> {
    match provider {
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "groq" => Some("GROQ_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        "together" => Some("TOGETHER_API_KEY"),
        "fireworks" => Some("FIREWORKS_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "perplexity" => Some("PERPLEXITY_API_KEY"),
        "zai" => Some("ZAI_API_KEY"),
        "ollama" => Some("OLLAMA_API_KEY"),
        "lm-studio" => Some("LMSTUDIO_API_KEY"),
        "vllm" => Some("VLLM_API_KEY"),
        "cerebras" => Some("CEREBRAS_API_KEY"),
        _ => None,
    }
}

/// Scan the environment for the first provider whose API-key env var is set and
/// return it. `EULER_PROVIDER` (if its key is present) and the popular providers
/// are checked first. Returns `None` if nothing is configured.
fn detect_provider() -> Option<String> {
    // Preferred order: explicit override, then common providers, then the rest.
    let mut order: Vec<&str> = Vec::new();
    if let Ok(p) = std::env::var("EULER_PROVIDER") {
        order.push(leak(&p));
    }
    for p in [
        "deepseek", "openai", "anthropic", "openrouter", "groq", "mistral",
        "zai", "xai", "together", "fireworks", "perplexity", "cerebras",
    ] {
        if !order.contains(&p) {
            order.push(p);
        }
    }
    for p in [
        "ollama", "lm-studio", "vllm",
    ] {
        if !order.contains(&p) {
            order.push(p);
        }
    }
    order
        .into_iter()
        .find(|p| provider_env_var(p).is_some_and(|v| std::env::var_os(v).is_some()))
        .map(String::from)
}

/// Leaking a string is fine here — we only do it a handful of times at startup
/// to build a static-lifetime search list.
fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Locate the project root: the parent of the native/ workspace dir, i.e.
    // two levels up from this crate.
    let project_root = locate_project_root()?;

    // Parse argv: --provider, --model, --api-key, --base-url, --resume, --help.
    let startup = parse_argv();

    // Enter the alternate screen + raw mode.
    enable_raw_mode().context("enable raw mode")?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen).context("enter alt screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("create terminal")?;
    terminal.clear()?;

    // Run the app; ensure we ALWAYS restore the terminal on exit.
    let result = run_app(&mut terminal, &project_root, startup).await;

    // Restore.
    disable_raw_mode().ok();
    execute!(io::stdout(), LeaveAlternateScreen).ok();

    result
}

/// Find the euler project root (where src/headless.ts lives).
fn locate_project_root() -> Result<PathBuf> {
    // Try CARGO_MANIFEST_DIR-derived path first (compile-time location).
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // native/euler-tui → project root is ../../
    let candidate = manifest
        .parent() // native/
        .and_then(|p| p.parent()); // project root
    if let Some(root) = candidate {
        if root.join("src").join("headless.ts").exists() {
            return Ok(root.to_path_buf());
        }
    }
    // Fall back to the current working directory.
    let cwd = std::env::current_dir().context("get cwd")?;
    if cwd.join("src").join("headless.ts").exists() {
        return Ok(cwd);
    }
    // Last resort: walk up from cwd.
    let mut dir = cwd.clone();
    for _ in 0..10 {
        if dir.join("src").join("headless.ts").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    anyhow::bail!("could not locate project root (src/headless.ts not found)")
}

/// Print the --help text to stderr and return. This is the one legitimate
/// stderr write in the binary: it's user-facing CLI output emitted before the
/// alternate screen is entered, not protocol traffic (the TS subprocess owns
/// its own stdio). The allow lives on the fn so clippy honors it reliably.
#[allow(clippy::print_stderr)]
fn print_help() {
    eprintln!(
        "euler-tui — interactive AI coding agent\n\n\
         Usage: euler-tui [options]\n\n\
         Options:\n  \
           --provider, -p <id>   Provider id (deepseek, openai, anthropic, ...)\n  \
           --model, -m <id>      Model id\n  \
           --api-key <key>       Explicit API key (overrides the provider env var)\n  \
           --base-url <url>      Explicit OpenAI-compatible base URL\n  \
           --resume, -r          Resume the most recent session\n  \
           --help, -h            Show this help\n\n\
         If --provider/--api-key are omitted, the first provider whose env var is set\n\
         is auto-detected (e.g. OPENAI_API_KEY, DEEPSEEK_API_KEY, ...).\n"
    );
}

fn parse_argv() -> Startup {
    let mut provider: Option<String> = std::env::var("EULER_PROVIDER").ok().filter(|s| !s.is_empty());
    let mut model: Option<String> = None;
    let mut api_key: Option<String> = None;
    let mut base_url: Option<String> = None;
    let mut resume = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--provider" | "-p" => {
                if let Some(p) = args.next() {
                    provider = Some(p);
                }
            }
            "--model" | "-m" => {
                if let Some(m) = args.next() {
                    model = Some(m);
                }
            }
            "--api-key" => {
                if let Some(k) = args.next() {
                    api_key = Some(k);
                }
            }
            "--base-url" => {
                if let Some(u) = args.next() {
                    base_url = Some(u);
                }
            }
            "--resume" | "-r" => {
                resume = true;
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            _ => {}
        }
    }

    // If no provider was given and no key overrides the env, auto-detect from env.
    let provider = provider.unwrap_or_else(|| {
        detect_provider().unwrap_or_else(|| "deepseek".to_string())
    });
    let model = model.unwrap_or_else(|| default_model_for(&provider));

    Startup {
        provider,
        model,
        api_key,
        base_url,
        resume,
    }
}

/// Default model id per provider (mirrors PROVIDERS in provider-config.ts).
fn default_model_for(provider: &str) -> String {
    match provider {
        "deepseek" => "deepseek-chat".into(),
        "openai" => "gpt-4o-mini".into(),
        "ollama" => "llama3.1".into(),
        "openrouter" => "anthropic/claude-3.5-sonnet".into(),
        "anthropic" => "claude-3-5-sonnet-20241022".into(),
        "groq" => "llama-3.3-70b-versatile".into(),
        "mistral" => "mistral-large-latest".into(),
        _ => "default".into(),
    }
}

/// Push the welcome message (on success) or a readable error (on failure) into
/// the chat. We never bail!() on init failure — the user gets an in-app message
/// they can act on, and the input box stays usable.
fn apply_init_result(app: &mut App, startup: &Startup, init_resp: crate::protocol::Response) {
    if init_resp.ok {
        app.chat.push(crate::app::ChatEntry {
            role: crate::app::Role::Assistant,
            text: format!(
                "Euler ready — provider: {}, model: {}.\nType a message and press Enter.\n  Alt/Shift+Enter = newline · Esc = interrupt · Ctrl-C/Ctrl-D = quit",
                startup.provider, startup.model
            ),
        });
    } else {
        let err = init_resp.error.unwrap_or_default();
        app.on_bridge_error(&err);
        app.chat.push(crate::app::ChatEntry {
            role: crate::app::Role::Assistant,
            text: format!(
                "⚠ Could not initialize the agent:\n  {err}\n\n\
                 Fix it and restart. Common causes:\n  \
                   • No API key in the environment. Set one, e.g.:\n      \
                     export OPENAI_API_KEY=sk-...\n      \
                     export DEEPSEEK_API_KEY=sk-...\n  \
                   • Or pass one explicitly:  euler-tui --api-key sk-... --base-url https://api.openai.com/v1\n\n\
                 Type /exit to quit."
            ),
        });
    }
}

/// Spawn the three background pumps (keyboard, tick, bridge) and return the
/// single receiver the main loop selects on. Each pump forwards its events as
/// `AppEvent`; dropping the receiver stops them.
fn spawn_event_pumps(bridge: &mut Bridge) -> Result<mpsc::Receiver<AppEvent>> {
    let (tx, rx) = mpsc::channel::<AppEvent>(256);

    // Keyboard reader task.
    let key_tx = tx.clone();
    tokio::spawn(async move {
        let mut events = EventStream::new();
        loop {
            match events.next().await {
                Some(Ok(CrosstermEvent::Key(k))) => {
                    if key_tx.send(AppEvent::Key(k)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(_)) | None => {}
                Some(Err(_)) => break,
            }
        }
    });

    // Tick task for the spinner.
    let tick_tx = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(120));
        loop {
            interval.tick().await;
            if tick_tx.send(AppEvent::Tick).await.is_err() {
                break;
            }
        }
    });

    // Bridge pump task: move messages from the bridge receiver to our channel.
    let bridge_tx = tx;
    let mut bridge_rx = bridge.take_rx().context("receiver already taken")?;
    tokio::spawn(async move {
        while let Some(msg) = bridge_rx.recv().await {
            if bridge_tx.send(AppEvent::Bridge(msg)).await.is_err() {
                break;
            }
        }
    });

    Ok(rx)
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    project_root: &std::path::Path,
    startup: Startup,
) -> Result<()> {
    // Spawn the bridge.
    let mut bridge = Bridge::spawn(project_root.to_path_buf())
        .context("spawn agent subprocess")?;

    // Initialize with credentials + resume flag.
    let config = InitializeConfig {
        provider: startup.provider.clone(),
        model: startup.model.clone(),
        api_key: startup.api_key.clone(),
        base_url: startup.base_url.clone(),
        max_tool_rounds: None,
        temperature: None,
        system_prompt: None,
        resume: startup.resume,
    };
    let init_resp = bridge.initialize(config).await.context("initialize agent")?;

    let mut app = App::new();
    app.on_initialized(&startup.provider, &startup.model);
    apply_init_result(&mut app, &startup, init_resp);

    // Set up event channels: keyboard (crossterm) + bridge messages + tick.
    let mut rx = spawn_event_pumps(&mut bridge)?;

    // Main loop.
    let mut bridge_busy = false;
    while let Some(event) = rx.recv().await {
        match event {
            AppEvent::Key(key) => {
                if handle_key(&mut app, key, &mut bridge, &mut bridge_busy).await? {
                    break;
                }
            }
            AppEvent::Bridge(msg) => {
                match msg {
                    AgentMessage::Event(ev) => {
                        app.apply(ev);
                    }
                    AgentMessage::Response(r) => {
                        if !r.ok {
                            app.on_bridge_error(
                                r.error.as_deref().unwrap_or("unknown error"),
                            );
                        }
                        // A process response means the op finished.
                        if bridge_busy {
                            bridge_busy = false;
                        }
                    }
                }
            }
            AppEvent::Tick => {
                app.tick_spinner();
            }
        }
        terminal.draw(|f| draw(f, &mut app))?;
    }

    // Clean shutdown.
    let _ = bridge.shutdown().await;
    Ok(())
}

/// Handle a slash command entered in the input box. Returns true if the app
/// should quit. Consumes the input. Commands:
///   /help, /?       — show help
///   /clear          — reset the agent's memory and clear the transcript
///   /model [id]     — show or note how to change the model (restart needed)
///   /exit, /quit    — quit
///
/// `bridge` is only touched by /clear (which tells the agent to reset its
/// in-memory conversation). All other commands are pure UI.
async fn handle_slash(
    app: &mut App,
    input: &str,
    bridge: &mut Bridge,
    bridge_busy: bool,
) -> Result<bool> {
    let parts: Vec<&str> = input.splitn(2, ' ').collect();
    let cmd = parts[0];
    let arg = parts.get(1).map_or("", |s| s.trim());
    app.clear_input();
    match cmd {
        "/help" | "/?" => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: "Commands:\n  /help          this help\n  /clear         reset agent memory + transcript\n  /model [id]    show or change model (restart needed)\n  /exit, /quit   quit\n\nKeys:\n  Enter          send message   Alt/Shift+Enter or Ctrl-J   newline\n  ↑/↓            input history (or move across lines)\n  Ctrl-U         clear input    Ctrl-W   delete word back\n  PgUp/PgDn      scroll chat    Ctrl-Up/Down, Home/End      scroll\n  Esc            interrupt the running turn\n  Ctrl-C / Ctrl-D  quit".into(),
            });
        }
        "/clear" => {
            // Tell the agent to forget prior turns, then clear the UI.
            if !bridge_busy {
                let _ = bridge.reset().await;
            }
            app.chat.clear();
            app.current_tools.clear();
            app.turn_count = 0;
            app.scroll = 0;
            app.last_error = None;
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: "(memory cleared — starting a fresh conversation)".into(),
            });
        }
        "/model" => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: if arg.is_empty() {
                    format!("Current model: {}. To switch, exit and re-run: euler-tui --model <id>", app.model)
                } else {
                    format!("To switch to '{arg}', exit (Ctrl-C) and re-run: euler-tui --model {arg}")
                },
            });
        }
        "/exit" | "/quit" => {
            app.quit = true;
            return Ok(true);
        }
        other => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: format!("Unknown command: {other}. Type /help for available commands."),
            });
        }
    }
    Ok(false)
}

/// Handle a key event. Returns Ok(true) if the app should quit.
async fn handle_key(
    app: &mut App,
    key: KeyEvent,
    bridge: &mut Bridge,
    bridge_busy: &mut bool,
) -> Result<bool> {
    // ---- Quit (Ctrl-C, Ctrl-D) ----
    if matches!(key.code, KeyCode::Char('c' | 'd'))
        && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        app.quit = true;
        return Ok(true);
    }

    // ---- Interrupt a running turn (Esc) ----
    if key.code == KeyCode::Esc && *bridge_busy {
        // Best-effort: tell the agent to abort. The coordinator aborts the
        // in-flight model request; the process op then resolves (ok:false or a
        // short final text) and we'll get the Response that clears bridge_busy.
        let _ = bridge.interrupt().await;
        app.on_interrupted();
        return Ok(false);
    }

    // ---- Multi-line input: Alt/Shift+Enter or Ctrl-J inserts a newline ----
    let is_newline_key = key.code == KeyCode::Enter
        && (key.modifiers.contains(KeyModifiers::ALT)
            || key.modifiers.contains(KeyModifiers::SHIFT));
    let is_ctrl_j = key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('j' | 'J'));
    if is_newline_key || is_ctrl_j {
        app.insert_newline();
        return Ok(false);
    }

    match (key.modifiers, key.code) {
        // ---- Input editing ----
        (KeyModifiers::CONTROL, KeyCode::Char('u')) => {
            app.clear_input();
        }
        (KeyModifiers::CONTROL, KeyCode::Char('w')) => {
            app.delete_word_back();
        }

        // ---- Chat scrolling ----
        (_, KeyCode::PageUp) => {
            app.scroll_page_up();
        }
        (_, KeyCode::PageDown) => {
            app.scroll_page_down();
        }
        (KeyModifiers::CONTROL, KeyCode::Up) => {
            app.scroll_up();
        }
        (KeyModifiers::CONTROL, KeyCode::Down) => {
            app.scroll_down();
        }
        (KeyModifiers::CONTROL, KeyCode::Home) => {
            app.scroll_to_top();
        }
        (KeyModifiers::CONTROL, KeyCode::End) => {
            app.scroll_to_bottom();
        }
        (KeyModifiers::NONE, KeyCode::Home) => {
            // Move cursor to start of current input line.
            app.move_line_start();
        }
        (KeyModifiers::NONE, KeyCode::End) => {
            app.move_line_end();
        }

        // ---- Submit (plain Enter when not busy) ----
        (_, KeyCode::Enter) => {
            if !*bridge_busy {
                // Slash commands are handled locally (no round-trip to agent).
                let trimmed = app.input.trim().to_string();
                if trimmed.starts_with('/') {
                    if handle_slash(app, &trimmed, bridge, *bridge_busy).await? {
                        return Ok(true);
                    }
                    return Ok(false);
                }
                if let Some(msg) = app.submit() {
                    bridge.process(&msg).await.context("send process request")?;
                    *bridge_busy = true;
                }
            }
            // If busy, Enter is ignored (don't queue).
        }

        // ---- Line-aware cursor movement (Up/Down) ----
        // On a single line, Up/Down walk input history (shell-like). On multiple
        // lines, they move the cursor across lines first; only at the top/bottom
        // edge do they fall through to history navigation.
        (KeyModifiers::NONE, KeyCode::Up) => {
            app.cursor_up_or_history_prev();
        }
        (KeyModifiers::NONE, KeyCode::Down) => {
            app.cursor_down_or_history_next();
        }
        (_, KeyCode::Left) => {
            app.move_cursor_left();
        }
        (_, KeyCode::Right) => {
            app.move_cursor_right();
        }
        (_, KeyCode::Backspace) => {
            app.backspace();
        }
        (KeyModifiers::NONE, KeyCode::Tab) => {
            // Insert two spaces (no completion engine yet).
            app.insert_char(' ');
            app.insert_char(' ');
        }
        (_, KeyCode::Char(c)) => {
            app.insert_char(c);
        }
        _ => {}
    }
    Ok(false)
}
