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

#[tokio::main]
async fn main() -> Result<()> {
    // Locate the project root: the parent of the native/ workspace dir, i.e.
    // two levels up from this crate.
    let project_root = locate_project_root()?;

    // Parse minimal argv: --provider, --model, --resume (placeholder).
    let (provider, model) = parse_argv();

    // Enter the alternate screen + raw mode.
    enable_raw_mode().context("enable raw mode")?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen).context("enter alt screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("create terminal")?;
    terminal.clear()?;

    // Run the app; ensure we ALWAYS restore the terminal on exit.
    let result = run_app(&mut terminal, &project_root, provider, model).await;

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

fn parse_argv() -> (String, String) {
    let mut provider = std::env::var("EULER_PROVIDER").unwrap_or_else(|_| "deepseek".to_string());
    let mut model = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--provider" => {
                if let Some(p) = args.next() {
                    provider = p;
                }
            }
            "--model" => {
                if let Some(m) = args.next() {
                    model = m;
                }
            }
            _ => {}
        }
    }
    if model.is_empty() {
        model = default_model_for(&provider);
    }
    (provider, model)
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

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    project_root: &std::path::Path,
    provider: String,
    model: String,
) -> Result<()> {
    // Spawn the bridge.
    let mut bridge = Bridge::spawn(project_root.to_path_buf())
        .await
        .context("spawn agent subprocess")?;

    // Initialize.
    let config = InitializeConfig {
        provider: provider.clone(),
        model: model.clone(),
        api_key: None,        // rely on env var resolution in headless.ts
        base_url: None,
        max_tool_rounds: None,
        temperature: None,
        system_prompt: None,
    };
    let init_resp = bridge.initialize(config).await.context("initialize agent")?;
    if !init_resp.ok {
        anyhow::bail!("agent initialize failed: {}", init_resp.error.unwrap_or_default());
    }

    let mut app = App::new();
    app.on_initialized(&provider, &model);

    // Welcome message.
    app.chat.push(crate::app::ChatEntry {
        role: crate::app::Role::Assistant,
        text: format!(
            "Euler agent ready — provider: {}, model: {}.\nType a message and press Enter. Ctrl-C to quit.",
            provider, model
        ),
    });

    // Set up event channels: keyboard (crossterm) + bridge messages + tick.
    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);

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
    let bridge_tx = tx.clone();
    let mut bridge_rx = bridge.take_rx().context("receiver already taken")?;
    tokio::spawn(async move {
        while let Some(msg) = bridge_rx.recv().await {
            if bridge_tx.send(AppEvent::Bridge(msg)).await.is_err() {
                break;
            }
        }
    });

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
        terminal.draw(|f| draw(f, &app))?;
    }

    // Clean shutdown.
    let _ = bridge.shutdown().await;
    Ok(())
}

/// Handle a slash command entered in the input box. Returns true if the app
/// should quit. Consumes the input. Commands:
///   /help, /?     — show help
///   /clear        — clear the chat transcript
///   /model <id>   — note: requires restart (re-run with --model <id>)
///   /exit, /quit  — quit
fn handle_slash(app: &mut App, input: &str) -> bool {
    let parts: Vec<&str> = input.splitn(2, ' ').collect();
    let cmd = parts[0];
    let arg = parts.get(1).map(|s| s.trim()).unwrap_or("");
    app.clear_input();
    match cmd {
        "/help" | "/?" => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: "Commands: /help, /clear, /model <id> (restart needed), /exit\nKeys: Enter=send, ↑↓=history, Ctrl-U=clear line, Ctrl-Up/Down=scroll, Ctrl-C=quit".into(),
            });
        }
        "/clear" => {
            app.chat.clear();
            app.current_tools.clear();
            app.turn_count = 0;
        }
        "/model" => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: if arg.is_empty() {
                    format!("Current model: {}. To switch, exit and re-run: euler-tui --model <id>", app.model)
                } else {
                    format!("To switch to '{}', exit (Ctrl-C) and re-run: euler-tui --model {}", arg, arg)
                },
            });
        }
        "/exit" | "/quit" => {
            app.quit = true;
            return true;
        }
        other => {
            app.chat.push(crate::app::ChatEntry {
                role: crate::app::Role::Assistant,
                text: format!("Unknown command: {}. Type /help for available commands.", other),
            });
        }
    }
    false
}

/// Handle a key event. Returns Ok(true) if the app should quit.
async fn handle_key(
    app: &mut App,
    key: KeyEvent,
    bridge: &mut Bridge,
    bridge_busy: &mut bool,
) -> Result<bool> {
    match (key.modifiers, key.code) {
        (KeyModifiers::CONTROL, KeyCode::Char('c')) => {
            app.quit = true;
            return Ok(true);
        }
        (KeyModifiers::CONTROL, KeyCode::Char('u')) => {
            app.clear_input();
        }
        (KeyModifiers::CONTROL, KeyCode::Up) => {
            app.scroll_up();
        }
        (KeyModifiers::CONTROL, KeyCode::Down) => {
            app.scroll_down();
        }
        (_, KeyCode::Enter) => {
            if !*bridge_busy {
                // Slash commands are handled locally (no round-trip to agent).
                let trimmed = app.input.trim().to_string();
                if trimmed.starts_with('/') {
                    if handle_slash(app, &trimmed) {
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
        (_, KeyCode::Up) => {
            app.history_prev();
        }
        (_, KeyCode::Down) => {
            app.history_next();
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
        (_, KeyCode::Char(c)) => {
            app.insert_char(c);
        }
        _ => {}
    }
    Ok(false)
}
