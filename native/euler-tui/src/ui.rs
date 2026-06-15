//! Terminal UI rendering.
//!
//! Pure rendering functions: take an immutable `App` ref + a `Frame`, draw.
//! No state mutation here — that lives in `app.rs`. This keeps the render code
//! easy to reason about (a render never changes what it draws).

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, BridgeStatus, Role, ToolStatus};

/// Top-level draw: splits the screen into chat / tools / input / status.
pub fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(8),     // chat
            Constraint::Length(6),  // tools panel
            Constraint::Length(3),  // input
            Constraint::Length(1),  // status bar
        ])
        .split(f.area());

    draw_chat(f, app, chunks[0]);
    draw_tools(f, app, chunks[1]);
    draw_input(f, app, chunks[2]);
    draw_status(f, app, chunks[3]);
}

fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP)
        .title(Span::styled(
            " euler ",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ));

    // Flatten chat entries into styled lines.
    let mut lines: Vec<Line> = Vec::new();
    for entry in &app.chat {
        let (label, label_color) = match entry.role {
            Role::User => ("you", Color::Blue),
            Role::Assistant => ("agent", Color::Green),
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{label}> "),
                Style::default().fg(label_color).add_modifier(Modifier::BOLD),
            ),
            Span::raw(""),
        ]));
        // Wrap the text body. Each source line becomes one or more visual lines.
        for text_line in entry.text.split('\n') {
            lines.push(Line::from(Span::styled(
                format!("  {text_line}"),
                Style::default().fg(if entry.role == Role::User {
                    Color::Reset
                } else {
                    Color::Gray
                }),
            )));
        }
        lines.push(Line::from(""));
    }

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .alignment(Alignment::Left);

    // Scroll: show the bottom of the conversation unless the user scrolled up.
    // ratatui's scroll is "lines from the top to skip". We compute it so the
    // most recent content is visible.
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
                        if *ok {
                            ("✓", Color::Green, format!(" → {}", first_line(snippet)))
                        } else {
                            ("✗", Color::Red, format!(" → {}", first_line(snippet)))
                        }
                    }
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("  {icon} "), Style::default().fg(color)),
                    Span::styled(tc.tool.clone(), Style::default().add_modifier(Modifier::BOLD)),
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
        .title(Span::styled(
            " input ",
            Style::default().fg(Color::Cyan),
        ));
    let para = Paragraph::new(app.input.as_str())
        .block(block)
        .wrap(Wrap { trim: true });
    f.render_widget(para, area);

    // Place the cursor at the input position.
    // Compute the (x,y) offset of the cursor within the input area, accounting
    // for wrapping. For simplicity, use the char count of the current line.
    let input_inner = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    };
    // Count chars before the cursor on the current logical line (no newlines in
    // input for now — single-line entry).
    let char_col = app.input[..app.input_cursor.min(app.input.len())]
        .chars()
        .count() as u16;
    let cx = input_inner.x + (char_col % input_inner.width.max(1));
    let cy = input_inner.y + (char_col / input_inner.width.max(1));
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
            " Enter=send  ↑↓=history  Ctrl-U=clear  Ctrl-C=quit ",
            Style::default().fg(Color::DarkGray),
        ),
    ]);

    let para = Paragraph::new(line);
    f.render_widget(para, area);
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
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
