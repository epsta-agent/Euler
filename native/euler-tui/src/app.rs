//! App state — the single source of truth the UI renders from.
//!
//! The bridge (subprocess reader) pushes `Event`s in; the UI reads `App` out.
//! All mutations go through `App::apply`, so the state transition logic is
//! centralized and testable without a terminal.

use std::collections::VecDeque;

use crate::protocol::Event;

/// One entry in the chat transcript.
#[derive(Debug, Clone)]
pub struct ChatEntry {
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// A tool call in progress or completed.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub tool: String,
    /// Short human-readable summary of the input (e.g. the path or command).
    pub summary: String,
    pub status: ToolStatus,
}

#[derive(Debug, Clone)]
pub enum ToolStatus {
    Running,
    Done { ok: bool, snippet: String },
}

/// Connection state of the bridge subprocess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeStatus {
    /// Not yet initialized.
    Starting,
    /// Initialized and idle, waiting for user input.
    Ready,
    /// Processing a user message (events streaming in).
    Working,
    /// The subprocess died or failed to initialize.
    Error,
}

/// The full application state. Cloned cheaply per render frame.
pub struct App {
    pub chat: Vec<ChatEntry>,
    /// Tool calls for the CURRENT assistant turn. Cleared when a user message
    /// is submitted, so the tool panel always reflects the active turn.
    pub current_tools: Vec<ToolCall>,
    pub input: String,
    /// Cursor position within `input` (byte offset — kept valid by insert/delete).
    pub input_cursor: usize,
    pub input_history: VecDeque<String>,
    pub history_index: Option<usize>,
    pub status: BridgeStatus,
    pub provider: String,
    pub model: String,
    pub turn_count: u32,
    /// Vertical scroll offset in the chat view (lines from the bottom).
    pub scroll: u16,
    /// Last error message (shown in the status bar when status == Error).
    pub last_error: Option<String>,
    /// Spinner frame counter for the working indicator.
    pub spinner: u8,
    /// Should the app quit?
    pub quit: bool,
}

impl App {
    pub fn new() -> Self {
        Self {
            chat: Vec::new(),
            current_tools: Vec::new(),
            input: String::new(),
            input_cursor: 0,
            input_history: VecDeque::new(),
            history_index: None,
            status: BridgeStatus::Starting,
            provider: String::new(),
            model: String::new(),
            turn_count: 0,
            scroll: 0,
            last_error: None,
            spinner: 0,
            quit: false,
        }
    }

    /// Record a successful initialize: store provider/model, mark ready.
    pub fn on_initialized(&mut self, provider: &str, model: &str) {
        self.provider = provider.to_string();
        self.model = model.to_string();
        self.status = BridgeStatus::Ready;
    }

    /// Submit the current input as a user message. Returns the message text.
    pub fn submit(&mut self) -> Option<String> {
        let text = self.input.trim().to_string();
        if text.is_empty() {
            return None;
        }
        // Save to history (skip duplicates of the most recent).
        if self.input_history.back().map(String::as_str) != Some(text.as_str()) {
            self.input_history.push_back(text.clone());
            if self.input_history.len() > 100 {
                self.input_history.pop_front();
            }
        }
        self.history_index = None;
        self.input.clear();
        self.input_cursor = 0;
        self.chat.push(ChatEntry {
            role: Role::User,
            text: text.clone(),
        });
        self.current_tools.clear();
        self.status = BridgeStatus::Working;
        self.scroll = 0; // snap to bottom on new turn
        Some(text)
    }

    /// Apply an agent event to the state.
    pub fn apply(&mut self, event: Event) {
        match event {
            Event::Message { data } => {
                // A message event carries the full assistant turn text. If the
                // last chat entry is an assistant turn still in progress, we
                // replace it; otherwise we start a new one.
                if matches!(
                    self.chat.last().map(|e| e.role),
                    Some(Role::Assistant)
                ) {
                    if let Some(last) = self.chat.last_mut() {
                        last.text = data.text;
                    }
                } else {
                    self.chat.push(ChatEntry {
                        role: Role::Assistant,
                        text: data.text,
                    });
                }
            }
            Event::ToolStart { data } => {
                self.current_tools.push(ToolCall {
                    tool: data.tool.clone(),
                    summary: summarize_tool_input(&data.tool, &data.input),
                    status: ToolStatus::Running,
                });
                self.turn_count = self.turn_count.saturating_add(1);
            }
            Event::ToolEnd { data, .. } => {
                // Mark the last matching running tool as done.
                let result_snippet = data.result.content.clone();
                let ok = !data.result.is_error;
                if let Some(tc) = self
                    .current_tools
                    .iter_mut()
                    .rev()
                    .find(|t| t.tool == data.tool && matches!(t.status, ToolStatus::Running))
                {
                    tc.status = ToolStatus::Done {
                        ok,
                        snippet: result_snippet,
                    };
                }
            }
            Event::Done { .. } => {
                self.status = BridgeStatus::Ready;
            }
            Event::Error { data } => {
                self.last_error = Some(data.error.clone());
                // An error mid-turn drops us back to ready so the user can retry.
                if self.status == BridgeStatus::Working {
                    self.status = BridgeStatus::Ready;
                }
            }
        }
    }

    /// Mark the bridge as failed (subprocess died / init error).
    pub fn on_bridge_error(&mut self, msg: &str) {
        self.status = BridgeStatus::Error;
        self.last_error = Some(msg.to_string());
    }

    /// Called when the user interrupts a running turn (Esc). Drops back to
    /// ready, records a marker entry, and clears the active tool panel so the
    /// spinner doesn't keep spinning on a dead turn.
    pub fn on_interrupted(&mut self) {
        if self.status == BridgeStatus::Working {
            self.status = BridgeStatus::Ready;
        }
        self.last_error = Some("interrupted".to_string());
        // Mark any running tools as stopped so the panel reflects reality.
        for tc in &mut self.current_tools {
            if matches!(tc.status, ToolStatus::Running) {
                tc.status = ToolStatus::Done {
                    ok: false,
                    snippet: "(interrupted)".to_string(),
                };
            }
        }
        self.chat.push(ChatEntry {
            role: Role::Assistant,
            text: "[interrupted]".to_string(),
        });
    }

    /// Advance the spinner frame (called on a timer tick).
    pub fn tick_spinner(&mut self) {
        self.spinner = self.spinner.wrapping_add(1);
    }

    // ---- input editing ----

    pub fn insert_char(&mut self, c: char) {
        self.input.insert(self.input_cursor, c);
        self.input_cursor += c.len_utf8();
    }

    /// Insert a newline at the cursor (multi-line input).
    pub fn insert_newline(&mut self) {
        self.input.insert(self.input_cursor, '\n');
        self.input_cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.input_cursor > 0 {
            // Find the previous char boundary.
            let prev = self.input[..self.input_cursor]
                .char_indices()
                .last()
                .map_or(0, |(i, _)| i);
            self.input.replace_range(prev..self.input_cursor, "");
            self.input_cursor = prev;
        }
    }

    /// Delete the word before the cursor (Ctrl-W). Skips any whitespace
    /// immediately before the cursor, then deletes the preceding non-whitespace
    /// run AND the whitespace before it — so repeated Ctrl-W chews through
    /// `foo bar baz` one token at a time with no leftover spaces.
    pub fn delete_word_back(&mut self) {
        if self.input_cursor == 0 {
            return;
        }
        let bytes = self.input.as_bytes();
        let mut i = self.input_cursor;
        // Skip trailing whitespace (cursor may sit just after a space).
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        // Skip the word.
        while i > 0 && !bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        // Also consume the whitespace before the word (so "foo bar|" -> "foo|").
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        let i = self.char_boundary(i);
        self.input.replace_range(i..self.input_cursor, "");
        self.input_cursor = i;
    }

    pub fn move_cursor_left(&mut self) {
        if let Some((i, _)) = self.input[..self.input_cursor].char_indices().last() {
            self.input_cursor = i;
        }
    }

    pub fn move_cursor_right(&mut self) {
        // Advance by the byte length of the next char (if any).
        if let Some((_, c)) = self.input[self.input_cursor..].char_indices().next() {
            self.input_cursor += c.len_utf8();
        }
    }

    /// Move the cursor to the start of the current logical line.
    pub fn move_line_start(&mut self) {
        let before = &self.input[..self.input_cursor];
        let start = before.rfind('\n').map_or(0, |i| i + 1);
        self.input_cursor = start;
    }

    /// Move the cursor to the end of the current logical line.
    pub fn move_line_end(&mut self) {
        let after = &self.input[self.input_cursor..];
        let end = after.find('\n').unwrap_or(after.len());
        self.input_cursor += end;
    }

    /// If the input has more than one line and the cursor isn't on the first
    /// line, move it up one line (same column, clamped). Returns true if it
    /// moved (so the caller knows not to walk input history). On the first line
    /// it returns false and does nothing, leaving history navigation to the
    /// caller — but we keep history Prev on the first line here too, so this
    /// method is the single entry point for the Up key.
    pub fn cursor_up_or_history_prev(&mut self) {
        if self.input.contains('\n') && !self.cursor_on_first_line() {
            self.move_cursor_line(-1);
        } else {
            self.history_prev();
        }
    }

    /// Down-key dual behavior: on a multi-line input, move down if not on the
    /// last line; otherwise (or on single-line input) walk input history next.
    pub fn cursor_down_or_history_next(&mut self) {
        if self.input.contains('\n') && !self.cursor_on_last_line() {
            self.move_cursor_line(1);
        } else {
            self.history_next();
        }
    }

    fn cursor_on_first_line(&self) -> bool {
        !self.input[..self.input_cursor].contains('\n')
    }

    fn cursor_on_last_line(&self) -> bool {
        !self.input[self.input_cursor..].contains('\n')
    }

    /// Move the cursor up (delta=-1) or down (delta=+1) by one visual line,
    /// preserving the column. Only valid for multi-line input.
    fn move_cursor_line(&mut self, delta: i32) {
        // Compute current line/col.
        let before = &self.input[..self.input_cursor];
        let line_idx = before.matches('\n').count();
        let col = before.rfind('\n').map_or(self.input_cursor, |i| self.input_cursor - i - 1);

        let target_line = line_idx as i32 + delta;
        if target_line < 0 {
            return;
        }
        let lines: Vec<&str> = self.input.split('\n').collect();
        if target_line as usize >= lines.len() {
            return;
        }
        // Byte offset to the start of the target line.
        let mut offset = 0usize;
        for (i, l) in lines.iter().enumerate() {
            if i == target_line as usize {
                break;
            }
            offset += l.len() + 1; // +1 for the '\n'
        }
        let target_line_str = lines[target_line as usize];
        let col = col.min(target_line_str.chars().count());
        let col_bytes = target_line_str
            .char_indices()
            .nth(col)
            .map_or(target_line_str.len(), |(i, _)| i);
        self.input_cursor = offset + col_bytes;
    }

    /// Snap a possibly-mid-char byte index to a char boundary (searching left).
    fn char_boundary(&self, i: usize) -> usize {
        if i >= self.input.len() {
            return self.input.len();
        }
        let mut i = i;
        while i > 0 && !self.input.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    pub fn history_prev(&mut self) {
        if self.input_history.is_empty() {
            return;
        }
        let idx = match self.history_index {
            None => self.input_history.len() - 1,
            Some(0) => return,
            Some(i) => i - 1,
        };
        self.history_index = Some(idx);
        self.input = self.input_history[idx].clone();
        self.input_cursor = self.input.len();
    }

    pub fn history_next(&mut self) {
        let idx = match self.history_index {
            None => return,
            Some(i) if i + 1 >= self.input_history.len() => {
                self.history_index = None;
                self.input.clear();
                self.input_cursor = 0;
                return;
            }
            Some(i) => i + 1,
        };
        self.history_index = Some(idx);
        self.input = self.input_history[idx].clone();
        self.input_cursor = self.input.len();
    }

    /// Half-page scroll up (Ctrl-Up). `scroll` is "lines of history hidden
    /// above the viewport", so scrolling UP (toward older content) increases it.
    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_add(3);
    }

    pub fn scroll_down(&mut self) {
        self.scroll = self.scroll.saturating_sub(3);
    }

    /// Page up (PgUp): move ~half the chat height toward older content. The
    /// `max_scroll` bound is provided by the UI (it knows the rendered height);
    /// we clamp to avoid scrolling past the top.
    pub fn scroll_page_up(&mut self) {
        self.scroll = self.scroll.saturating_add(10);
    }

    pub fn scroll_page_down(&mut self) {
        self.scroll = self.scroll.saturating_sub(10);
    }

    /// Jump to the top of the transcript (Ctrl-Home).
    pub fn scroll_to_top(&mut self) {
        // u16::MAX; the UI clamps to the actual max on each render.
        self.scroll = u16::MAX;
    }

    /// Jump to the bottom (Ctrl-End / newest content).
    pub fn scroll_to_bottom(&mut self) {
        self.scroll = 0;
    }

    /// Clamp the scroll offset so it can't exceed the available history. Called
    /// by the UI after it knows how many lines exist and how many fit.
    pub fn clamp_scroll(&mut self, max_scroll: usize) {
        if self.scroll as usize > max_scroll {
            self.scroll = max_scroll as u16;
        }
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.input_cursor = 0;
    }
}

/// Build a short human-readable summary of a tool's input for the tool panel.
fn summarize_tool_input(tool: &str, input: &serde_json::Value) -> String {
    let get = |key: &str| input.get(key).and_then(|v| v.as_str());
    match tool {
        "read" | "write" | "edit" | "ls" | "glob" | "hex_dump" => {
            get("path").unwrap_or("?").to_string()
        }
        "bash" => {
            let cmd = get("command").unwrap_or("");
            // First line, truncated.
            let first_line = cmd.lines().next().unwrap_or("");
            if first_line.len() > 60 {
                format!("{}…", &first_line[..60])
            } else {
                first_line.to_string()
            }
        }
        "grep" | "search" | "find" => {
            get("pattern").unwrap_or("?").to_string()
        }
        "run_tests" => get("command").unwrap_or("(auto-detect)").to_string(),
        "latex_check" | "latex_fix_boxes" => get("file").unwrap_or("main.tex").to_string(),
        _ => {
            // Generic: show the first string-valued field.
            input
                .as_object()
                .and_then(|o| {
                    o.values()
                        .find_map(|v| v.as_str().map(String::from))
                })
                .unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::*;
    use serde_json::json;

    #[test]
    fn submit_adds_user_message_and_sets_working() {
        let mut app = App::new();
        app.status = BridgeStatus::Ready;
        app.input = "hello".into();
        let msg = app.submit().unwrap();
        assert_eq!(msg, "hello");
        assert_eq!(app.chat.len(), 1);
        assert_eq!(app.chat[0].role, Role::User);
        assert_eq!(app.status, BridgeStatus::Working);
        assert!(app.input.is_empty());
    }

    #[test]
    fn submit_ignores_empty_input() {
        let mut app = App::new();
        app.input = "   ".into();
        assert!(app.submit().is_none());
        assert!(app.chat.is_empty());
    }

    #[test]
    fn message_event_creates_then_updates_assistant_turn() {
        let mut app = App::new();
        app.apply(Event::Message {
            data: MessageData {
                text: "partial".into(),
            },
        });
        assert_eq!(app.chat.len(), 1);
        app.apply(Event::Message {
            data: MessageData {
                text: "full response".into(),
            },
        });
        assert_eq!(app.chat.len(), 1); // updated, not appended
        assert_eq!(app.chat[0].text, "full response");
    }

    #[test]
    fn tool_start_then_end_marks_done() {
        let mut app = App::new();
        app.apply(Event::ToolStart {
            data: ToolEventData {
                tool: "bash".into(),
                input: json!({"command": "ls"}),
            },
        });
        assert_eq!(app.current_tools.len(), 1);
        assert!(matches!(
            app.current_tools[0].status,
            ToolStatus::Running
        ));

        app.apply(Event::ToolEnd {
            data: ToolEndData {
                tool: "bash".into(),
                input: json!({}),
                result: ToolResult {
                    content: "file1\nfile2".into(),
                    is_error: false,
                },
            },
        });
        match &app.current_tools[0].status {
            ToolStatus::Done { ok, .. } => assert!(*ok),
            ToolStatus::Running => panic!("expected Done"),
        }
    }

    #[test]
    fn done_event_returns_to_ready() {
        let mut app = App::new();
        app.status = BridgeStatus::Working;
        app.apply(Event::Done {
            data: DoneData {
                response: "x".into(),
            },
        });
        assert_eq!(app.status, BridgeStatus::Ready);
    }

    #[test]
    fn input_editing() {
        let mut app = App::new();
        app.insert_char('h');
        app.insert_char('i');
        assert_eq!(app.input, "hi");
        app.move_cursor_left();
        app.insert_char('!');
        assert_eq!(app.input, "h!i");
        app.backspace();
        assert_eq!(app.input, "hi");
    }

    #[test]
    fn multiline_input_editing() {
        let mut app = App::new();
        // Type "abc", newline, "def".
        for c in "abc".chars() { app.insert_char(c); }
        app.insert_newline();
        for c in "def".chars() { app.insert_char(c); }
        assert_eq!(app.input, "abc\ndef");

        // Home moves to start of the current (second) line only.
        app.move_line_start();
        assert_eq!(&app.input[app.input_cursor..], "def");

        // Left from the start of line 2 lands on the newline char, then on 'c'.
        app.move_cursor_left(); // onto '\n' (index 3)
        assert_eq!(&app.input[app.input_cursor..], "\ndef");
        app.move_cursor_left(); // onto 'c' (index 2)
        assert_eq!(&app.input[app.input_cursor..], "c\ndef");

        // End of the current (first) line is just before the newline.
        app.move_line_end();
        assert_eq!(&app.input[app.input_cursor..], "\ndef");
    }

    #[test]
    fn delete_word_back() {
        let mut app = App::new();
        app.input = "foo bar baz".into();
        app.input_cursor = app.input.len();
        app.delete_word_back();
        // Eats "baz" + preceding whitespace.
        assert_eq!(app.input, "foo bar");
        app.delete_word_back();
        assert_eq!(app.input, "foo");
        // No-op at start of input.
        app.input_cursor = 0;
        app.delete_word_back();
        assert_eq!(app.input, "foo");
    }

    #[test]
    fn on_interrupted_marks_running_tools_and_drops_to_ready() {
        let mut app = App::new();
        app.status = BridgeStatus::Working;
        app.apply(Event::ToolStart {
            data: ToolEventData {
                tool: "bash".into(),
                input: json!({"command": "sleep 100"}),
            },
        });
        app.on_interrupted();
        assert_eq!(app.status, BridgeStatus::Ready);
        match &app.current_tools[0].status {
            ToolStatus::Done { ok, snippet } => {
                assert!(!*ok);
                assert_eq!(snippet, "(interrupted)");
            }
            ToolStatus::Running => panic!("expected interrupted tool"),
        }
        // A marker chat entry was pushed.
        assert!(app.chat.last().unwrap().text.contains("interrupted"));
    }

    #[test]
    fn scroll_clamps_to_max() {
        let mut app = App::new();
        app.scroll_to_top(); // sets u16::MAX
        app.clamp_scroll(10);
        assert_eq!(app.scroll, 10);
        app.scroll_to_bottom();
        assert_eq!(app.scroll, 0);
        // Clamping below zero is a no-op (already 0).
        app.clamp_scroll(5);
        assert_eq!(app.scroll, 0);
    }

    #[test]
    fn history_navigation() {
        let mut app = App::new();
        app.input = "first".into();
        app.submit();
        app.input = "second".into();
        app.submit();
        // Now empty. Go back in history.
        app.history_prev();
        assert_eq!(app.input, "second");
        app.history_prev();
        assert_eq!(app.input, "first");
        app.history_next();
        assert_eq!(app.input, "second");
        app.history_next();
        assert!(app.input.is_empty());
    }

    #[test]
    fn summarize_tools() {
        assert_eq!(
            summarize_tool_input("read", &json!({"path": "/app/main.py"})),
            "/app/main.py"
        );
        assert_eq!(
            summarize_tool_input("bash", &json!({"command": "echo hello world"})),
            "echo hello world"
        );
        // Long command truncated.
        let long = "x".repeat(100);
        assert_eq!(
            summarize_tool_input("bash", &json!({"command": long})),
            format!("{}…", "x".repeat(60))
        );
    }
}
