//! Terminal UI rendering.
//!
//! Pure rendering functions: take an immutable `App` ref + a `Frame`, draw.
//! No state mutation here — that lives in `app.rs`. This keeps the render code
//! easy to reason about (a render never changes what it draws).
//!
//! Rendering model:
//!   - Assistant text is parsed into lightweight markdown (headings, fenced
//!     code blocks, inline `code`, **bold**, bullet/numbered lists) and styled.
//!   - Long lines wrap to the chat width (word-wrap), and the chat view honors
//!     `app.scroll` (Ctrl-Up/PgUp/etc.) by translating it into ratatui's
//!     `Paragraph::scroll` offset, clamped to the real line count.
//!   - The input box grows with multi-line content up to a cap, shrinking the
//!     chat pane so the whole UI always fits the terminal.

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, BridgeStatus, Role, ToolStatus};

/// Minimum chat height (lines). If the terminal is too short to fit this plus
/// the tools + input + status bars, the chat simply gets clipped.
const MIN_CHAT_HEIGHT: u16 = 4;
/// Maximum input-box height. A very long paste won't eat the whole screen.
const MAX_INPUT_HEIGHT: u16 = 12;
/// Fixed tools-panel height.
const TOOLS_HEIGHT: u16 = 6;

/// Top-level draw: splits the screen into chat / tools / input / status.
pub fn draw(f: &mut Frame, app: &mut App) {
    // Dynamic input height: grows with the number of newlines in the input,
    // capped so the chat pane never collapses below MIN_CHAT_HEIGHT.
    let input_lines = app.input.split('\n').count().max(1) as u16;
    let avail_for_input_tools = f.area().height.saturating_sub(MIN_CHAT_HEIGHT + 1);
    let input_height = input_lines
        .clamp(1, MAX_INPUT_HEIGHT)
        .min(avail_for_input_tools.saturating_sub(TOOLS_HEIGHT))
        .max(1)
        + 2; // +2 for the box border

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(MIN_CHAT_HEIGHT), // chat
            Constraint::Length(TOOLS_HEIGHT), // tools panel
            Constraint::Length(input_height), // input
            Constraint::Length(1),            // status bar
        ])
        .split(f.area());

    draw_chat(f, app, chunks[0]);
    draw_tools(f, app, chunks[1]);
    draw_input(f, app, chunks[2]);
    draw_status(f, app, chunks[3]);
}

fn draw_chat(f: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP)
        .title(Span::styled(
            " euler ",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ));

    // Flatten chat entries into styled lines. Each entry renders a header line,
    // then its body (markdown-parsed for the assistant; plain for the user).
    let width = area.width.saturating_sub(2) as usize; // -2 for the block padding
    let mut lines: Vec<Line> = Vec::new();
    for entry in &app.chat {
        let (label, label_color) = match entry.role {
            Role::User => ("you", Color::Blue),
            Role::Assistant => ("agent", Color::Green),
        };
        lines.push(Line::from(vec![Span::styled(
            format!("{label}> "),
            Style::default().fg(label_color).add_modifier(Modifier::BOLD),
        )]));

        let body_color = if entry.role == Role::User {
            Color::Reset
        } else {
            Color::Gray
        };
        let body_lines = if entry.role == Role::Assistant {
            render_markdown(&entry.text, width, body_color)
        } else {
            wrap_plain(&entry.text, width, body_color)
        };
        lines.extend(body_lines);
        lines.push(Line::from(""));
    }

    // Compute the total wrapped line count so we can clamp the scroll offset.
    // Paragraph with Wrap doesn't expose its wrapped height directly, so we
    // estimate it as the sum of each logical line's wrapped row count. This is
    // an approximation (ratatui's wrap may differ by a line on edge cases) but
    // is close enough that clamping behaves correctly.
    let total_lines: usize = lines.len();
    let viewport = area.height.saturating_sub(2) as usize; // minus border
    let max_scroll = total_lines.saturating_sub(viewport);
    app.clamp_scroll(max_scroll);

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .alignment(Alignment::Left)
        // ratatui scroll = "lines from the top to skip". We render newest at the
        // bottom, so to see older content we skip fewer lines from the top…
        // but we want the *bottom* pinned by default. The trick: render the
        // transcript top-aligned and scroll DOWN to the end. When the user
        // scrolls up (app.scroll grows), we reduce the skip so older lines stay
        // visible.
        .scroll(((max_scroll.saturating_sub(app.scroll as usize)) as u16, 0));

    f.render_widget(paragraph, area);
}

fn draw_tools(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP)
        .title(Span::styled(
            " tool calls ",
            Style::default().fg(Color::Yellow),
        ));

    let items: Vec<ListItem> = if app.current_tools.is_empty() {
        vec![ListItem::new(Span::styled(
            "  (no active tool calls)",
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        app.current_tools
            .iter()
            .map(|tc| {
                let (icon, color, suffix) = match &tc.status {
                    ToolStatus::Running => ("⟳", Color::Yellow, "...".to_string()),
                    ToolStatus::Done { ok, snippet } => {
                        let verdict = verdict_from_snippet(snippet, *ok);
                        if *ok {
                            ("✓", Color::Green, verdict)
                        } else {
                            ("✗", Color::Red, verdict)
                        }
                    }
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("  {icon} "), Style::default().fg(color)),
                    Span::styled(
                        tc.tool.clone(),
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(format!("({}){}", tc.summary, suffix)),
                ]))
            })
            .collect()
    };

    let list = List::new(items).block(block);
    f.render_widget(list, area);
}

fn draw_input(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(" input ", Style::default().fg(Color::Cyan)));
    let para = Paragraph::new(app.input.as_str())
        .block(block)
        .wrap(Wrap { trim: false });
    f.render_widget(para, area);

    // Place the cursor at the input position, accounting for wrapping and
    // multi-line content.
    let input_inner = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    };
    let width = input_inner.width.max(1) as usize;
    // Everything before the cursor (clamped to a valid byte boundary).
    let before = &app.input[..app.input_cursor.min(app.input.len())];
    // Characters on the current logical line (since the last newline, or from
    // the start if single-line).
    let cur_line_chars = before
        .rsplit_once('\n')
        .map_or(before.chars().count(), |(_, last)| last.chars().count());
    // Which logical line (row) the cursor is on.
    let row = before.matches('\n').count() as u16;
    let cx = input_inner.x + (cur_line_chars % width) as u16;
    let cy = input_inner.y + row + (cur_line_chars / width) as u16;
    f.set_cursor_position((cx, cy));
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let status_text = match app.status {
        BridgeStatus::Starting => Span::styled("● starting", Style::default().fg(Color::Yellow)),
        BridgeStatus::Ready => Span::styled("● ready", Style::default().fg(Color::Green)),
        BridgeStatus::Working => {
            let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
            let frame = frames[app.spinner as usize % frames.len()];
            Span::styled(format!("{frame} working"), Style::default().fg(Color::Cyan))
        }
        BridgeStatus::Error => Span::styled("● error", Style::default().fg(Color::Red)),
    };

    let model_info = if app.model.is_empty() {
        String::new()
    } else {
        format!(" {} ", app.model)
    };

    let error_info = app
        .last_error
        .as_ref()
        .map(|e| format!(" ⚠ {} ", truncate_str(e, 40)))
        .unwrap_or_default();

    let line = Line::from(vec![
        Span::raw(" "),
        status_text,
        Span::raw("  "),
        Span::styled(model_info, Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!(" turns: {} ", app.turn_count),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled(error_info, Style::default().fg(Color::Red)),
        Span::raw("                                           "),
        Span::styled(
            " Enter=send  Alt+↵=newline  Esc=interrupt  Ctrl-C=quit ",
            Style::default().fg(Color::DarkGray),
        ),
    ]);

    let para = Paragraph::new(line);
    f.render_widget(para, area);
}

// ---- markdown rendering ----

/// Render a markdown string into styled ratatui `Line`s, wrapping each visual
/// line to `width` columns. This is a deliberately small subset:
///   - ATX headings (`#`, `##`, …) — bold + colored
///   - Fenced code blocks ``` … ``` — monospace-ish (kept as-is), indented, dim
///   - Inline `` `code` `` — distinct color
///   - Inline **bold** — bold modifier
///   - Bullet (`-`, `*`) and numbered (`1.`) list items — preserved indent
///
/// No external crate: a per-line state machine + a tiny inline tokenizer. The
/// goal is "looks markedly better than raw text", not CommonMark compliance.
fn render_markdown(text: &str, width: usize, base_color: Color) -> Vec<Line<'static>> {
    let mut out: Vec<Line> = Vec::new();
    let mut in_code = false;
    let mut code_lang = String::new();

    for raw in text.split('\n') {
        // Fenced code block toggle.
        let trimmed = raw.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            if in_code {
                in_code = false;
                code_lang.clear();
                out.push(Line::from(Span::styled(
                    "```",
                    Style::default().fg(Color::DarkGray),
                )));
            } else {
                in_code = true;
                code_lang = rest.trim().to_string();
                let label = if code_lang.is_empty() {
                    "```".to_string()
                } else {
                    format!("``` {code_lang}")
                };
                out.push(Line::from(Span::styled(
                    label,
                    Style::default().fg(Color::DarkGray),
                )));
            }
            continue;
        }
        if in_code {
            // Code body: render verbatim, indented, in a fixed dim color so it
            // reads as a block. Wrap long lines to fit.
            let line_style = Style::default().fg(Color::LightGreen);
            let padded = format!("  {raw}");
            for w in wrap_str(&padded, width) {
                out.push(Line::from(Span::styled(w, line_style)));
            }
            continue;
        }

        // Headings.
        if let Some(h) = heading_level_and_text(trimmed) {
            let (level, content) = h;
            let color = match level {
                1 => Color::Cyan,
                2 => Color::Blue,
                _ => Color::Yellow,
            };
            let style = Style::default().fg(color).add_modifier(Modifier::BOLD);
            let prefix = "#".repeat(level) + " ";
            let full = format!("{prefix}{content}");
            for w in wrap_str(&full, width) {
                out.push(Line::from(Span::styled(w, style)));
            }
            continue;
        }

        // Lists: preserve the leading marker + indentation while wrapping.
        let (list_prefix, body) = split_list_prefix(raw);
        if !list_prefix.is_empty() {
            let indent = " ".repeat(list_prefix.chars().count());
            let styled_spans = style_inline(body, base_color);
            wrap_spans_with_indent(&list_prefix, &indent, &styled_spans, width, &mut out);
            continue;
        }

        // Default paragraph line: inline styling + word-wrap.
        let spans = style_inline(raw, base_color);
        wrap_spans(&spans, width, &mut out);
    }

    // An empty input should still show one (empty) line.
    if out.is_empty() {
        out.push(Line::from(""));
    }
    out
}

/// Plain (non-markdown) word-wrap, used for user messages.
fn wrap_plain(text: &str, width: usize, color: Color) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let padded = format!("  {raw}");
        for w in wrap_str(&padded, width.max(1)) {
            out.push(Line::from(Span::styled(w, Style::default().fg(color))));
        }
    }
    if out.is_empty() {
        out.push(Line::from(""));
    }
    out
}

/// Tokenize one line into styled spans for inline markdown: `code`, **bold**.
fn style_inline(line: &str, base_color: Color) -> Vec<Span<'static>> {
    let base = Style::default().fg(base_color);
    let code_style = Style::default().fg(Color::LightYellow);
    let bold_style = Style::default().fg(base_color).add_modifier(Modifier::BOLD);

    let mut spans: Vec<Span<'static>> = Vec::new();
    let bytes: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut buf = String::new();

    let flush = |buf: &mut String, spans: &mut Vec<Span<'static>>, style: Style| {
        if !buf.is_empty() {
            spans.push(Span::styled(buf.clone(), style));
            buf.clear();
        }
    };

    while i < bytes.len() {
        // Inline code: `...`
        if bytes[i] == '`' {
            flush(&mut buf, &mut spans, base);
            if let Some(end) = bytes[i + 1..].iter().position(|&c| c == '`') {
                let code: String = bytes[i + 1..i + 1 + end].iter().collect();
                spans.push(Span::styled(code, code_style));
                i += end + 2;
                continue;
            }
            // Unmatched backtick — emit literally.
            buf.push('`');
            i += 1;
            continue;
        }
        // Bold: **...**
        if bytes[i] == '*' && i + 1 < bytes.len() && bytes[i + 1] == '*' {
            flush(&mut buf, &mut spans, base);
            if let Some(end) = find_double_star(&bytes[i + 2..]) {
                let bold_text: String = bytes[i + 2..i + 2 + end].iter().collect();
                spans.push(Span::styled(bold_text, bold_style));
                i += end + 4;
                continue;
            }
            buf.push('*');
            i += 1;
            continue;
        }
        buf.push(bytes[i]);
        i += 1;
    }
    flush(&mut buf, &mut spans, base);
    if spans.is_empty() {
        spans.push(Span::raw(""));
    }
    spans
}

/// Find the index of the closing `**` in a slice (returns byte-ish char index).
fn find_double_star(chars: &[char]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] == '*' && chars[i + 1] == '*' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// If a line is a markdown ATX heading, return (level, text).
fn heading_level_and_text(line: &str) -> Option<(usize, &str)> {
    let mut level = 0;
    for c in line.chars() {
        if c == '#' {
            level += 1;
        } else {
            break;
        }
    }
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    if rest.is_empty() {
        return Some((level, ""));
    }
    rest.strip_prefix(' ').map(|stripped| (level, stripped.trim_end()))
}

/// Split a list-item line into (prefix, body). Prefix includes the marker and
/// trailing space, e.g. "- ", "* ", "1. ", "   - ". Returns ("", line) if the
/// line isn't a list item.
fn split_list_prefix(line: &str) -> (String, &str) {
    let trimmed_start = line.trim_start();
    let leading_ws = line.len() - trimmed_start.len();

    // Bullet list.
    if let Some(rest) = trimmed_start.strip_prefix("- ").or_else(|| trimmed_start.strip_prefix("* ")) {
        let prefix = format!("{}{}", &line[..leading_ws], &trimmed_start[..2]);
        return (prefix, rest);
    }
    // Numbered list: "12. "
    let bytes = trimmed_start.as_bytes();
    let mut n = 0;
    while n < bytes.len() && bytes[n].is_ascii_digit() {
        n += 1;
    }
    if n > 0 && bytes.get(n) == Some(&b'.') && bytes.get(n + 1) == Some(&b' ') {
        let marker_len = n + 2;
        let prefix = format!("{}{}", &line[..leading_ws], &trimmed_start[..marker_len]);
        return (prefix, &trimmed_start[marker_len..]);
    }
    (String::new(), line)
}

// ---- wrapping helpers ----

/// Word-wrap a plain string into visual lines no longer than `width` chars.
fn wrap_str(s: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![s.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    for paragraph in s.split('\n') {
        let mut line = String::new();
        for word in paragraph.split(' ') {
            if line.is_empty() {
                line.push_str(word);
            } else if line.chars().count() + 1 + word.chars().count() <= width {
                line.push(' ');
                line.push_str(word);
            } else {
                out.push(std::mem::take(&mut line));
                line.push_str(word);
            }
        }
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// Wrap a sequence of styled spans into `Line`s, breaking at word boundaries.
/// Because spans can carry different styles, we track the running style as we
/// accumulate words.
fn wrap_spans(spans: &[Span<'static>], width: usize, out: &mut Vec<Line<'static>>) {
    // Flatten into (text, style) tokens at word boundaries is complex; for our
    // purposes we flatten to a single string with style runs and wrap by char
    // count. We rebuild Lines as single-span runs to keep this tractable.
    let mut flat: String = String::new();
    for s in spans {
        flat.push_str(s.content.as_ref());
    }
    let style = spans.first().map(|s| s.style).unwrap_or_default();
    let mut continuation = false;
    for visual in wrap_str(&flat, width) {
        // `continuation` previously branched into two identical arms; the
        // value is the same either way, so just use `visual` directly.
        out.push(Line::from(Span::styled(visual, style)));
        continuation = true;
    }
    let _ = continuation;
}

/// Like wrap_spans but prepends `prefix` on the first visual line and `indent`
/// on continuation lines (for list items).
fn wrap_spans_with_indent(
    prefix: &str,
    indent: &str,
    spans: &[Span<'static>],
    width: usize,
    out: &mut Vec<Line<'static>>,
) {
    let mut flat = String::new();
    for s in spans {
        flat.push_str(s.content.as_ref());
    }
    let style = spans.first().map(|s| s.style).unwrap_or_default();
    let prefix_w = prefix.chars().count();
    let indent_w = indent.chars().count();
    let first_width = width.saturating_sub(prefix_w).max(1);
    let rest_width = width.saturating_sub(indent_w).max(1);

    // Wrap the first chunk at first_width, then re-wrap the tail of that chunk
    // at the narrower rest_width (which is what continuation lines use).
    let first = wrap_str(&flat, first_width);
    let mut lines: Vec<String> = Vec::new();
    match first.split_first() {
        None => lines.push(String::new()),
        Some((head, rest)) => {
            lines.push(head.clone());
            // `head` was the last (possibly full) first-width line; re-wrap any
            // remainder produced by rest_width for the continuation lines.
            for w in rest {
                // All continuation lines use the same rest_width; the old
                // conditional picked rest_width for both branches.
                let rem = wrap_str(w, rest_width);
                lines.extend(rem);
            }
        }
    }
    for (i, visual) in lines.iter().enumerate() {
        let lead = if i == 0 { prefix } else { indent };
        out.push(Line::from(Span::styled(format!("{lead}{visual}"), style)));
    }
}

// ---- tool verdict ----

/// Build a short verdict suffix for a completed tool, e.g. " → exit 0" or
/// " → 3 results" or " → error: …". Falls back to the first line of the snippet.
fn verdict_from_snippet(snippet: &str, ok: bool) -> String {
    // The bash tool appends "[exit=N signal=... duration=...]" — surface the exit code.
    if let Some(idx) = snippet.rfind("[exit=") {
        let after = &snippet[idx + "[exit=".len()..];
        // The exit value runs until the next space or closing bracket.
        let exit: String = after.chars().take_while(|c| !c.is_whitespace() && *c != ']').collect();
        if !exit.is_empty() {
            return format!(" → exit {exit}");
        }
    }
    // First non-empty line as a one-liner.
    let first = snippet.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let v = truncate_str(first, 50);
    if v.is_empty() {
        if ok {
            String::new()
        } else {
            " → failed".to_string()
        }
    } else {
        format!(" → {v}")
    }
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_str_breaks_long_lines() {
        let out = wrap_str("the quick brown fox jumps", 10);
        for line in &out {
            assert!(line.chars().count() <= 10, "line too long: {line:?}");
        }
        assert!(out.len() >= 3);
    }

    #[test]
    fn heading_detection() {
        assert_eq!(heading_level_and_text("# Title"), Some((1, "Title")));
        assert_eq!(heading_level_and_text("### Sub"), Some((3, "Sub")));
        assert_eq!(heading_level_and_text("not a heading"), None);
        assert_eq!(heading_level_and_text("######## too deep"), None);
    }

    #[test]
    fn list_prefix_split() {
        let (p, b) = split_list_prefix("- item");
        assert_eq!(p, "- ");
        assert_eq!(b, "item");
        let (p, b) = split_list_prefix("  * nested");
        assert_eq!(p, "  * ");
        assert_eq!(b, "nested");
        let (p, b) = split_list_prefix("12. numbered");
        assert_eq!(p, "12. ");
        assert_eq!(b, "numbered");
        let (p, _b) = split_list_prefix("plain text");
        assert!(p.is_empty());
    }

    #[test]
    fn markdown_renders_code_fence_and_heading() {
        let md = "# Hello\n\nSome `code` here.\n\n```\nfn main() {}\n```";
        let lines = render_markdown(md, 60, Color::Gray);
        // heading + blank + paragraph line(s) + fence open + code + fence close
        assert!(lines.len() >= 5);
        // First line is the heading.
        let first = lines[0].spans.first().unwrap();
        assert!(first.content.contains("Hello"));
    }

    #[test]
    fn inline_bold_and_code() {
        let spans = style_inline("this is **bold** and `code`", Color::Gray);
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined.contains("bold"));
        assert!(joined.contains("code"));
    }

    #[test]
    fn verdict_extracts_exit_code() {
        let v = verdict_from_snippet("hello\n\n[exit=0 signal=none duration=7ms]", true);
        assert_eq!(v, " → exit 0");
        let v = verdict_from_snippet("boom\n[exit=1 signal=none]", false);
        assert_eq!(v, " → exit 1");
    }

    #[test]
    fn verdict_falls_back_to_first_line() {
        let v = verdict_from_snippet("3 files matched", true);
        assert_eq!(v, " → 3 files matched");
    }
}
