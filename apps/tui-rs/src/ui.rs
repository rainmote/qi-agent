use crate::{
    app::{App, InlineStreamCommit, SelectorKind},
    markdown,
    model::{HistoryItem, ToolCall, ToolStatus},
    sanitize,
    theme::Theme,
    viewport::{HistoryViewport, ViewportMetric},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const LOGO: [&str; 6] = [
    "  ___ ___     _   ___ ___ _  _ _____ ",
    " | _ ) _ )   /_\\ / __| __| \\| |_   _|",
    " | _ \\ _ \\  / _ \\ (_ | _|| .` | | |  ",
    " |___/___/ /_/ \\_\\___|___|_|\\_| |_|  ",
    "                                     ",
    "                                     ",
];

const INPUT_VIEWPORT_ROWS: usize = 10;
const STREAMING_TRANSCRIPT_RESERVE_ROWS: u16 = 3;

#[derive(Clone, Debug)]
struct InputVisualLine {
    start: usize,
    end: usize,
}

pub struct StreamingCommitCandidate {
    pub lines: Vec<Line<'static>>,
    pub state: InlineStreamCommit,
}

pub fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(app.theme.background)),
        area,
    );
    if app.projection.is_none() {
        let text = if let Some(error) = app.error.as_deref() {
            Line::styled(
                format!("Failed to start TUI: {error}"),
                Style::default().fg(app.theme.error),
            )
        } else {
            Line::styled(
                "Loading session and commands…",
                Style::default().fg(app.theme.accent),
            )
        };
        frame.render_widget(Paragraph::new(text), inset(area, 2, 1));
        return;
    }

    if app.has_dialog() {
        let waiting_for_confirmation = app
            .active_interaction()
            .is_some_and(|interaction| interaction.kind == "approval");
        let confirmation_rows = u16::from(waiting_for_confirmation);
        let available = area.height.saturating_sub(3 + confirmation_rows);
        let dialog_height = dialog_rows(app, area.width).min(available);
        let chunks = Layout::vertical([
            Constraint::Min(3),
            Constraint::Length(confirmation_rows),
            Constraint::Length(dialog_height),
        ])
        .split(area);
        render_transcript(frame, app, chunks[0]);
        if waiting_for_confirmation {
            render_confirmation_wait(frame, app, chunks[1]);
        }
        render_dialog(frame, app, chunks[2]);
    } else {
        let busy_rows = busy_rows(app, area.width);
        let above_rows = extension_rows(app, "above-editor", 3);
        let below_rows = extension_rows(app, "below-editor", 2);
        let suggestion_rows = suggestion_rows(app);
        let input_rows = input_rows(app, area.width);
        let composer_rows = 2 + input_rows + suggestion_rows;
        let queue_rows = queue_rows(app);
        let status_rows = u16::from(app.error.is_some() || app.notice.is_some());
        let chunks = Layout::vertical([
            Constraint::Min(3),
            Constraint::Length(status_rows),
            Constraint::Length(above_rows),
            Constraint::Length(busy_rows),
            Constraint::Length(queue_rows),
            Constraint::Length(composer_rows),
            Constraint::Length(below_rows),
            Constraint::Length(1),
        ])
        .split(area);
        render_transcript(frame, app, chunks[0]);
        render_status(frame, app, chunks[1]);
        render_extensions(frame, app, chunks[2], "above-editor");
        render_loading(frame, app, chunks[3]);
        render_queue(frame, app, chunks[4]);
        render_composer(frame, app, chunks[5]);
        render_extensions(frame, app, chunks[6], "below-editor");
        render_footer(frame, app, chunks[7]);
    }
}

/// Returns the number of rows currently needed by the redrawable portion of
/// the inline UI. The terminal layer caps this value against the available
/// screen space, so long streaming output still leaves native scrollback
/// usable while short idle/composer states do not reserve empty rows.
pub fn inline_content_height(app: &App, width: u16) -> u16 {
    if app.projection.is_none() {
        return 3;
    }

    let transcript_rows = inline_transcript_rows(app, width);
    if app.has_dialog() {
        return transcript_rows
            .max(3)
            .saturating_add(u16::from(
                app.active_interaction()
                    .is_some_and(|interaction| interaction.kind == "approval"),
            ))
            .saturating_add(dialog_rows(app, width));
    }

    let transcript_rows = if transcript_rows == 0 {
        0
    } else {
        transcript_rows.max(3)
    };
    transcript_rows.saturating_add(inline_chrome_rows(app, width))
}

fn inline_chrome_rows(app: &App, width: u16) -> u16 {
    u16::from(app.error.is_some() || app.notice.is_some())
        .saturating_add(extension_rows(app, "above-editor", 3))
        .saturating_add(busy_rows(app, width))
        .saturating_add(queue_rows(app))
        .saturating_add(2 + input_rows(app, width) + suggestion_rows(app))
        .saturating_add(extension_rows(app, "below-editor", 2))
        .saturating_add(1)
}

fn inline_transcript_rows(app: &App, width: u16) -> u16 {
    inline_transcript_rows_with_commit(app, width, app.inline_stream_commit.as_ref())
}

fn inline_transcript_rows_with_commit(
    app: &App,
    width: u16,
    stream_commit: Option<&InlineStreamCommit>,
) -> u16 {
    let Some(projection) = app.projection.as_ref() else {
        return 0;
    };
    let start = if app.inline_mode {
        app.committed_history_count.min(projection.history.len())
    } else {
        0
    };
    let mut lines = if start == 0 && (!app.inline_mode || !app.header_committed) {
        header_lines(app, width)
    } else {
        Vec::new()
    };
    for (offset, item) in projection.history[start..].iter().enumerate() {
        if !lines.is_empty() {
            lines.push(Line::raw(""));
        }
        lines.extend(history_lines_with_stream_commit(
            app,
            stream_commit,
            start + offset,
            item,
            app.details_expanded || app.expanded_tool_groups.contains(item.id()),
            width.saturating_sub(6) as usize,
            false,
        ));
    }
    rendered_rows(&lines, width as usize)
        .min(u16::MAX as usize)
        .try_into()
        .unwrap_or(u16::MAX)
}

fn busy_rows(app: &App, width: u16) -> u16 {
    if !app.busy() {
        0
    } else if width <= 30 || width >= 80 {
        1
    } else {
        2
    }
}

fn input_rows(app: &App, width: u16) -> u16 {
    input_visual_layout(app, width)
        .0
        .len()
        .min(INPUT_VIEWPORT_ROWS) as u16
}

fn input_visual_layout(app: &App, width: u16) -> (Vec<InputVisualLine>, usize) {
    let text = app.editor.text();
    let content_width = width.saturating_sub(2).max(1) as usize;
    let mut lines = Vec::new();
    let mut logical_start = 0usize;
    loop {
        let logical_end = text[logical_start..]
            .find('\n')
            .map_or(text.len(), |offset| logical_start + offset);
        if logical_start == logical_end {
            lines.push(InputVisualLine {
                start: logical_start,
                end: logical_end,
            });
        } else {
            let mut visual_start = logical_start;
            let mut visual_width = 0usize;
            for (relative, grapheme) in text[logical_start..logical_end].grapheme_indices(true) {
                let grapheme_start = logical_start + relative;
                let grapheme_width = grapheme.width();
                if visual_width > 0 && visual_width.saturating_add(grapheme_width) > content_width {
                    lines.push(InputVisualLine {
                        start: visual_start,
                        end: grapheme_start,
                    });
                    visual_start = grapheme_start;
                    visual_width = 0;
                }
                visual_width = visual_width.saturating_add(grapheme_width);
            }
            lines.push(InputVisualLine {
                start: visual_start,
                end: logical_end,
            });
        }
        if logical_end == text.len() {
            break;
        }
        logical_start = logical_end + 1;
    }

    let cursor = app.editor.cursor();
    let cursor_line = lines
        .iter()
        .enumerate()
        .position(|(index, line)| {
            cursor >= line.start
                && (cursor < line.end
                    || (cursor == line.end
                        && lines.get(index + 1).is_none_or(|next| next.start != cursor)))
        })
        .unwrap_or_else(|| lines.len().saturating_sub(1));
    (lines, cursor_line)
}

fn suggestion_rows(app: &App) -> u16 {
    app.command_suggestions().len().min(8) as u16
}

fn queue_rows(app: &App) -> u16 {
    app.projection.as_ref().map_or(0, |projection| {
        if projection.queue.is_empty() {
            0
        } else {
            (projection.queue.len() as u16).min(3) + u16::from(projection.queue.len() > 3) + 1
        }
    })
}

fn dialog_rows(app: &App, width: u16) -> u16 {
    if let Some(selector) = app.selector.as_ref() {
        let list_rows = selector
            .options
            .len()
            .saturating_add(4)
            .min(u16::MAX as usize) as u16;
        let preview_rows = u16::from(selector.kind == SelectorKind::Theme && width >= 74) * 9;
        return list_rows.max(preview_rows).max(6);
    }
    let Some(interaction) = app.active_interaction() else {
        return 0;
    };
    let body_width = width.saturating_sub(6).max(1) as usize;
    let message_rows = plain_text_rows(&sanitize::text(&interaction.message), body_width);
    let editor_rows = if matches!(interaction.kind.as_str(), "input" | "custom") {
        plain_text_rows(
            if app.dialog_editor.is_empty() {
                interaction.placeholder.as_deref().unwrap_or("Type a value")
            } else {
                app.dialog_editor.text()
            },
            body_width.saturating_sub(2).max(1),
        )
    } else {
        0
    };
    message_rows
        .saturating_add(editor_rows)
        .saturating_add(interaction.items.len().min(u16::MAX as usize) as u16)
        .saturating_add(6)
        .max(6)
}

fn plain_text_rows(value: &str, width: usize) -> u16 {
    let width = width.max(1);
    value
        .split('\n')
        .map(|line| line.width().max(1).div_ceil(width))
        .sum::<usize>()
        .min(u16::MAX as usize) as u16
}

fn render_transcript(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    if app.inline_mode {
        render_inline_transcript(frame, app, area);
    } else {
        render_virtual_transcript(frame, app, area);
    }
}

fn render_inline_transcript(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let Some(projection) = app.projection.as_ref() else {
        return;
    };
    let history = &projection.history;
    let history_base = app.committed_history_count.min(history.len());
    let visible = area.height as usize;
    let end = history.len();
    let mut selected = Vec::<(usize, Vec<Line<'static>>)>::new();
    let mut logical_rows = 0usize;
    for index in (history_base..end).rev() {
        let item = &history[index];
        let lines = history_lines_for_app(
            app,
            index,
            item,
            app.details_expanded || app.expanded_tool_groups.contains(item.id()),
            area.width.saturating_sub(6) as usize,
            app.focused_tool_group == Some(index),
        );
        logical_rows += rendered_rows(&lines, area.width.saturating_sub(6) as usize)
            + usize::from(!selected.is_empty());
        selected.push((index, lines));
        if logical_rows >= visible.saturating_add(8) {
            break;
        }
    }
    selected.reverse();
    let start = selected.first().map_or(end, |(index, _)| *index);
    let content_area = area;
    let mut lines = if start == 0 && !app.header_committed {
        header_lines(app, content_area.width)
    } else {
        Vec::new()
    };
    for (_, item_lines) in selected {
        if !lines.is_empty() {
            lines.push(Line::raw(""));
        }
        lines.extend(item_lines);
    }
    let wrapped_rows = rendered_rows(&lines, content_area.width as usize);
    let vertical_scroll = wrapped_rows.saturating_sub(visible) as u16;
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .scroll((vertical_scroll, 0))
            .wrap(Wrap { trim: false }),
        content_area,
    );
}

fn render_virtual_transcript(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    if area.width == 0 || area.height == 0 || app.projection.is_none() {
        return;
    }
    let content_area = if area.width > 1 {
        Rect::new(area.x, area.y, area.width - 1, area.height)
    } else {
        area
    };
    let content_width = content_area.width.max(1);
    let mut viewport = std::mem::take(&mut app.history_viewport);
    if let Some(projection) = app.projection.as_ref() {
        viewport.prune_height_cache(
            projection.history.len(),
            projection.history.iter().map(HistoryItem::id),
        );
    }

    viewport.update_layout(
        virtual_metrics(app, &viewport, content_width),
        content_area.height as usize,
    );
    let mut window = viewport.visible_window(1);
    let mut lines = Vec::new();
    let mut settled = false;
    for _ in 0..8 {
        lines = virtual_window_lines(app, &mut viewport, content_width, window.start, window.end);
        viewport.update_layout(
            virtual_metrics(app, &viewport, content_width),
            content_area.height as usize,
        );
        let next_window = viewport.visible_window(1);
        if next_window.start == window.start && next_window.end == window.end {
            window = next_window;
            settled = true;
            break;
        }
        window = next_window;
    }

    if !settled {
        // Keep rendered rows and crop coordinates from the same metric pass.
        // The newly recorded measurements will settle on the next redraw.
        window = viewport.visible_window(1);
        lines = virtual_window_lines(app, &mut viewport, content_width, window.start, window.end);
    }
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .scroll((window.crop_top.min(u16::MAX as usize) as u16, 0))
            .wrap(Wrap { trim: false }),
        content_area,
    );
    if area.width > 1 {
        render_virtual_scrollbar(
            frame,
            app,
            Rect::new(area.right() - 1, area.y, 1, area.height),
            &viewport,
        );
    }
    app.history_viewport = viewport;
}

fn virtual_metrics(app: &App, viewport: &HistoryViewport, width: u16) -> Vec<ViewportMetric> {
    let header_height = rendered_rows(&header_lines(app, width), width as usize).max(1);
    let mut metrics = vec![ViewportMetric::header(header_height)];
    let Some(projection) = app.projection.as_ref() else {
        return metrics;
    };
    metrics.extend(projection.history.iter().map(|item| {
        let expanded = app.details_expanded || app.expanded_tool_groups.contains(item.id());
        let estimated = estimated_history_height(item);
        match viewport.cached_height(item.id(), width, expanded) {
            Some((height, true)) if item.is_final() => ViewportMetric::history(item.id(), height),
            Some((height, _)) => {
                ViewportMetric::estimated_history(item.id(), height.max(estimated))
            }
            None => ViewportMetric::estimated_history(item.id(), estimated),
        }
    }));
    metrics
}

fn estimated_history_height(item: &HistoryItem) -> usize {
    // Deliberately do not scan message text here: this runs for every history
    // item on every frame, including restored sessions with large messages.
    // Visible items are measured exactly and cached immediately.
    match item {
        HistoryItem::User { .. } | HistoryItem::Info { .. } | HistoryItem::Error { .. } => 3,
        HistoryItem::Assistant { reasoning, .. } if reasoning.is_some() => 5,
        HistoryItem::Assistant { .. } => 4,
        HistoryItem::ToolGroup { tools, .. } => tools.len().clamp(1, 3).saturating_add(1),
    }
}

fn virtual_window_lines(
    app: &App,
    viewport: &mut HistoryViewport,
    width: u16,
    start: usize,
    end: usize,
) -> Vec<Line<'static>> {
    let Some(projection) = app.projection.as_ref() else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for virtual_index in start..end {
        if virtual_index == 0 {
            lines.extend(header_lines(app, width));
            continue;
        }
        let history_index = virtual_index - 1;
        let Some(item) = projection.history.get(history_index) else {
            continue;
        };
        let expanded = app.details_expanded || app.expanded_tool_groups.contains(item.id());
        let mut item_lines = vec![Line::raw("")];
        item_lines.extend(history_lines_for_app(
            app,
            history_index,
            item,
            expanded,
            width.saturating_sub(6) as usize,
            app.focused_tool_group == Some(history_index),
        ));
        let height = rendered_rows(&item_lines, width as usize).max(1);
        viewport.record_height(item.id(), width, expanded, height, item.is_final());
        lines.extend(item_lines);
    }
    lines
}

/// Builds immutable transcript rows that can be inserted above Ratatui's
/// inline viewport. Once inserted, these rows belong to the terminal's native
/// scrollback rather than the application's redraw buffer.
pub fn committed_lines(
    app: &App,
    start: usize,
    end: usize,
    include_header: bool,
    leading_separator: bool,
    width: u16,
) -> Vec<Line<'static>> {
    let Some(projection) = app.projection.as_ref() else {
        return Vec::new();
    };
    let start = start.min(projection.history.len());
    let end = end.clamp(start, projection.history.len());
    let mut lines = Vec::new();
    let continues_partial_item = !include_header
        && app
            .inline_stream_commit
            .as_ref()
            .is_some_and(|commit| commit.history_index == start);
    if leading_separator && (include_header || start < end) && !continues_partial_item {
        lines.push(Line::raw(""));
    }
    if include_header {
        lines.extend(header_lines(app, width));
    }
    for (index, item) in projection.history[start..end].iter().enumerate() {
        if !lines.is_empty() {
            lines.push(Line::raw(""));
        }
        let global_index = start + index;
        lines.extend(history_lines_for_app(
            app,
            global_index,
            item,
            app.details_expanded || app.expanded_tool_groups.contains(item.id()),
            width.saturating_sub(6) as usize,
            app.focused_tool_group == Some(global_index),
        ));
    }
    lines
}

pub fn committed_height(lines: &[Line<'_>], width: u16) -> u16 {
    rendered_rows(lines, width as usize)
        .min(u16::MAX as usize)
        .max(1) as u16
}

/// Returns one complete Markdown prefix that can leave the redrawable inline
/// viewport without changing the order or final contents of the assistant
/// message. Fenced blocks remain live until their closing fence arrives.
pub fn streaming_commit_candidate(
    app: &App,
    width: u16,
    terminal_rows: u16,
) -> Option<StreamingCommitCandidate> {
    if !app.inline_mode || app.has_dialog() {
        return None;
    }
    let projection = app.projection.as_ref()?;
    let history_index = app.committed_history_count;
    let HistoryItem::Assistant {
        id,
        text,
        reasoning,
        streaming: true,
    } = projection.history.get(history_index)?
    else {
        return None;
    };

    let (committed_bytes, committed_reasoning) = app
        .inline_stream_commit
        .as_ref()
        .filter(|commit| {
            commit.history_index == history_index
                && commit.item_id == *id
                && text.starts_with(&commit.committed_text)
                && commit.committed_reasoning.as_ref().is_none_or(|prefix| {
                    reasoning
                        .as_deref()
                        .is_some_and(|value| value.starts_with(prefix))
                })
        })
        .map_or((0, None), |commit| {
            (
                commit.committed_text.len(),
                commit.committed_reasoning.clone(),
            )
        });
    let transcript_capacity = terminal_rows
        .saturating_sub(inline_chrome_rows(app, width))
        .max(3);
    let target_rows = transcript_capacity
        .saturating_sub(STREAMING_TRANSCRIPT_RESERVE_ROWS)
        .max(3);
    if inline_transcript_rows(app, width) <= target_rows {
        return None;
    }

    let boundaries = safe_markdown_boundaries(&text[committed_bytes..]);
    let mut selected = None;
    for relative_boundary in boundaries {
        let boundary = committed_bytes + relative_boundary;
        let state = InlineStreamCommit {
            history_index,
            item_id: id.clone(),
            committed_text: text[..boundary].to_owned(),
            committed_reasoning: reasoning.clone().or_else(|| committed_reasoning.clone()),
        };
        let remaining_rows = inline_transcript_rows_with_commit(app, width, Some(&state));
        selected = Some(state);
        if remaining_rows <= target_rows {
            break;
        }
    }
    let state = selected?;
    let chunk = HistoryItem::Assistant {
        id: id.clone(),
        text: text[committed_bytes..state.committed_text.len()].to_owned(),
        reasoning: reasoning_suffix(reasoning.as_ref(), committed_reasoning.as_ref()),
        streaming: false,
    };
    let mut lines = history_lines(
        &chunk,
        &app.theme,
        app.details_expanded,
        width.saturating_sub(6) as usize,
        app.spinner_frame,
        false,
    );
    if committed_bytes > 0 && !lines.is_empty() {
        suppress_assistant_prefixes(&mut lines, committed_reasoning.is_some(), true);
        lines.insert(0, Line::raw(""));
    } else if committed_bytes == 0
        && committed_reasoning.is_none()
        && (app.header_committed || history_index > 0)
        && !lines.is_empty()
    {
        lines.insert(0, Line::raw(""));
    }
    (!lines.is_empty()).then_some(StreamingCommitCandidate { lines, state })
}

fn reasoning_suffix(reasoning: Option<&String>, committed: Option<&String>) -> Option<String> {
    match (reasoning, committed) {
        (Some(reasoning), Some(committed)) => reasoning
            .strip_prefix(committed)
            .filter(|suffix| !suffix.is_empty())
            .map(ToOwned::to_owned),
        (Some(reasoning), None) => Some(reasoning.clone()),
        (None, _) => None,
    }
}

fn suppress_assistant_prefixes(
    lines: &mut [Line<'static>],
    suppress_reasoning: bool,
    suppress_text: bool,
) {
    for line in lines {
        for span in &mut line.spans {
            let suppress = (suppress_reasoning && span.content.as_ref() == "∵ ")
                || (suppress_text && span.content.as_ref() == "◆ ");
            if suppress {
                span.content = "  ".into();
                break;
            }
        }
    }
}

fn safe_markdown_boundaries(text: &str) -> Vec<usize> {
    let mut boundaries = Vec::new();
    let mut fence = None::<(char, usize)>;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let marker = trimmed
            .chars()
            .next()
            .filter(|marker| matches!(marker, '`' | '~'))
            .map(|marker| {
                (
                    marker,
                    trimmed.chars().take_while(|ch| ch == &marker).count(),
                )
            })
            .filter(|(_, count)| *count >= 3);
        if let Some((marker, count)) = marker {
            match fence {
                Some((open_marker, open_count)) if marker == open_marker && count >= open_count => {
                    fence = None;
                }
                None => fence = Some((marker, count)),
                _ => {}
            }
        }
        offset += line.len();
        if fence.is_none() && trimmed.is_empty() && offset > 0 {
            boundaries.push(offset);
        }
    }
    boundaries
}

fn rendered_rows(lines: &[Line<'_>], width: usize) -> usize {
    let width = width.max(1);
    lines
        .iter()
        .map(|line| line.width().max(1).div_ceil(width))
        .sum()
}

fn render_virtual_scrollbar(
    frame: &mut Frame<'_>,
    app: &App,
    area: Rect,
    viewport: &HistoryViewport,
) {
    if area.height == 0 || viewport.total_rows() <= viewport.viewport_rows() {
        return;
    }
    let height = area.height as usize;
    let total = viewport.total_rows();
    let visible = viewport.viewport_rows().max(1);
    let thumb_height = ((height * visible) / total).clamp(1, height);
    let max_scroll = total.saturating_sub(visible).max(1);
    let thumb_top = ((viewport.scroll_top().min(max_scroll) * height.saturating_sub(thumb_height))
        / max_scroll)
        .min(height.saturating_sub(thumb_height));
    let lines = (0..height)
        .map(|row| {
            let thumb = row >= thumb_top && row < thumb_top + thumb_height;
            Line::styled(
                if thumb { "█" } else { "│" },
                Style::default().fg(if thumb {
                    app.theme.focused
                } else {
                    app.theme.secondary
                }),
            )
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn header_lines(app: &App, width: u16) -> Vec<Line<'static>> {
    let projection = app.projection.as_ref().expect("projection");
    let model = projection.models.as_ref().and_then(|m| m.current.as_ref());
    let provider = model
        .and_then(|m| m.provider.as_deref())
        .unwrap_or("Plugin");
    let model_name = model
        .and_then(|m| m.model.as_deref())
        .or_else(|| model.map(|m| m.id.as_str()))
        .unwrap_or("");
    let info = [
        vec![
            Span::styled(
                format!(">_ {}", app.brand),
                Style::default()
                    .fg(app.theme.accent)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" (v{})", app.version),
                Style::default().fg(app.theme.secondary),
            ),
        ],
        vec![Span::styled(" ", Style::default())],
        vec![Span::styled(
            format!("{provider} | {model_name} (/model to change)"),
            Style::default().fg(app.theme.secondary),
        )],
        vec![Span::styled(
            shorten_path(&app.cwd.to_string_lossy(), 54),
            Style::default().fg(app.theme.secondary),
        )],
    ];
    let show_logo = width >= 87;
    let mut lines = Vec::with_capacity(8);
    if show_logo {
        let panel_width = (width.saturating_sub(43)).min(60) as usize;
        let top = format!("┌{}┐", "─".repeat(panel_width.saturating_sub(2)));
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(LOGO[0], Style::default().fg(app.theme.gradient[0])),
            Span::raw("  "),
            Span::styled(top, Style::default().fg(app.theme.secondary)),
        ]));
        for row in 0..4 {
            let mut spans = vec![
                Span::raw("  "),
                Span::styled(
                    LOGO[row + 1],
                    Style::default().fg(app.theme.gradient[(row + 1).min(2)]),
                ),
                Span::raw("  "),
                Span::styled("│", Style::default().fg(app.theme.secondary)),
            ];
            spans.extend(info[row].clone());
            let used = spans.iter().map(|span| span.content.width()).sum::<usize>();
            let target = 2 + 37 + 2 + panel_width - 1;
            spans.push(Span::raw(" ".repeat(target.saturating_sub(used))));
            spans.push(Span::styled("│", Style::default().fg(app.theme.secondary)));
            lines.push(Line::from(spans));
        }
        let bottom = format!("└{}┘", "─".repeat(panel_width.saturating_sub(2)));
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(LOGO[5], Style::default().fg(app.theme.gradient[2])),
            Span::raw("  "),
            Span::styled(bottom, Style::default().fg(app.theme.secondary)),
        ]));
    } else {
        let panel_width = width.saturating_sub(4) as usize;
        lines.push(Line::styled(
            format!("  ┌{}┐", "─".repeat(panel_width.saturating_sub(2))),
            Style::default().fg(app.theme.secondary),
        ));
        for row in info {
            let text = row
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>();
            lines.push(Line::from(vec![
                Span::styled("  │ ", Style::default().fg(app.theme.secondary)),
                Span::raw(truncate(&text, panel_width.saturating_sub(4))),
                Span::styled(
                    format!(
                        "{}│",
                        " ".repeat(
                            panel_width.saturating_sub(
                                3 + text.width().min(panel_width.saturating_sub(4))
                            )
                        )
                    ),
                    Style::default().fg(app.theme.secondary),
                ),
            ]));
        }
        lines.push(Line::styled(
            format!("  └{}┘", "─".repeat(panel_width.saturating_sub(2))),
            Style::default().fg(app.theme.secondary),
        ));
    }
    lines.push(Line::styled(
        "  Tips: Type / to see all available commands.",
        Style::default().fg(app.theme.secondary),
    ));
    lines
}

fn history_lines(
    item: &HistoryItem,
    theme: &Theme,
    expanded: bool,
    width: usize,
    spinner_frame: usize,
    focused: bool,
) -> Vec<Line<'static>> {
    match item {
        HistoryItem::User { text, .. } => prefixed_lines(">", text, theme.accent),
        HistoryItem::Assistant {
            text, reasoning, ..
        } => {
            let mut lines = Vec::new();
            if let Some(reasoning) = reasoning {
                if expanded {
                    lines.extend(prefixed_lines("∵", reasoning, theme.secondary));
                } else {
                    lines.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(
                            "∵ Thinking (Ctrl+O to expand)",
                            Style::default().fg(theme.secondary),
                        ),
                    ]));
                }
            }
            if !text.is_empty() {
                lines.extend(prefixed_rich_lines(
                    "◆",
                    markdown::render(text, theme),
                    theme.primary,
                ));
            }
            lines
        }
        HistoryItem::Info { text, .. } => prefixed_lines("∴", text, theme.link),
        HistoryItem::Error { text, .. } => prefixed_lines("x", text, theme.error),
        HistoryItem::ToolGroup { tools, .. } => {
            let mut lines = tool_lines(tools, theme, expanded, width, spinner_frame);
            if focused
                && let Some(line) = lines.first_mut()
                && let Some(prefix) = line.spans.first_mut()
            {
                *prefix = Span::styled("› ", Style::default().fg(theme.accent));
            }
            lines
        }
    }
}

fn history_lines_for_app(
    app: &App,
    history_index: usize,
    item: &HistoryItem,
    expanded: bool,
    width: usize,
    focused: bool,
) -> Vec<Line<'static>> {
    history_lines_with_stream_commit(
        app,
        app.inline_stream_commit.as_ref(),
        history_index,
        item,
        expanded,
        width,
        focused,
    )
}

fn history_lines_with_stream_commit(
    app: &App,
    stream_commit: Option<&InlineStreamCommit>,
    history_index: usize,
    item: &HistoryItem,
    expanded: bool,
    width: usize,
    focused: bool,
) -> Vec<Line<'static>> {
    let Some(commit) = stream_commit
        .filter(|commit| commit.history_index == history_index && commit.item_id == item.id())
    else {
        return history_lines(
            item,
            &app.theme,
            expanded,
            width,
            app.spinner_frame,
            focused,
        );
    };
    let HistoryItem::Assistant {
        id,
        text,
        reasoning,
        streaming,
    } = item
    else {
        return history_lines(
            item,
            &app.theme,
            expanded,
            width,
            app.spinner_frame,
            focused,
        );
    };
    let Some(text) = text.strip_prefix(&commit.committed_text) else {
        return history_lines(
            item,
            &app.theme,
            expanded,
            width,
            app.spinner_frame,
            focused,
        );
    };
    let tail_reasoning = match (reasoning.as_ref(), commit.committed_reasoning.as_ref()) {
        (Some(reasoning), Some(committed)) => {
            let Some(suffix) = reasoning.strip_prefix(committed) else {
                return history_lines(
                    item,
                    &app.theme,
                    expanded,
                    width,
                    app.spinner_frame,
                    focused,
                );
            };
            (!suffix.is_empty()).then(|| suffix.to_owned())
        }
        (Some(reasoning), None) => Some(reasoning.clone()),
        (None, _) => None,
    };
    let tail = HistoryItem::Assistant {
        id: id.clone(),
        text: text.to_owned(),
        reasoning: tail_reasoning,
        streaming: *streaming,
    };
    let mut lines = history_lines(
        &tail,
        &app.theme,
        expanded,
        width,
        app.spinner_frame,
        focused,
    );
    if !lines.is_empty() {
        suppress_assistant_prefixes(
            &mut lines,
            commit.committed_reasoning.is_some(),
            !commit.committed_text.is_empty(),
        );
        lines.insert(0, Line::raw(""));
    }
    lines
}

fn prefixed_lines(prefix: &str, text: &str, color: ratatui::style::Color) -> Vec<Line<'static>> {
    sanitize::text(text)
        .lines()
        .enumerate()
        .map(|(index, line)| {
            Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    if index == 0 {
                        format!("{prefix} ")
                    } else {
                        "  ".into()
                    },
                    Style::default().fg(color),
                ),
                Span::styled(line.to_owned(), Style::default().fg(color)),
            ])
        })
        .collect()
}

fn prefixed_rich_lines(
    prefix: &str,
    mut lines: Vec<Line<'static>>,
    color: ratatui::style::Color,
) -> Vec<Line<'static>> {
    if lines.is_empty() {
        return lines;
    }
    for (index, line) in lines.iter_mut().enumerate() {
        line.spans.insert(
            0,
            Span::styled(
                if index == 0 {
                    format!("{prefix} ")
                } else {
                    "  ".into()
                },
                Style::default().fg(color),
            ),
        );
        line.spans.insert(0, Span::raw("  "));
    }
    lines
}

fn tool_lines(
    tools: &[ToolCall],
    theme: &Theme,
    expanded: bool,
    width: usize,
    spinner_frame: usize,
) -> Vec<Line<'static>> {
    let force_individual = expanded
        || tools
            .iter()
            .any(|tool| matches!(tool.status, ToolStatus::Confirming | ToolStatus::Error));
    let collapsible = if force_individual {
        Vec::new()
    } else {
        tools
            .iter()
            .filter(|tool| is_collapsible(tool) && tool.status != ToolStatus::Canceled)
            .collect::<Vec<_>>()
    };
    let individual = if force_individual {
        tools.iter().collect::<Vec<_>>()
    } else {
        tools
            .iter()
            .filter(|tool| !is_collapsible(tool) || tool.status == ToolStatus::Canceled)
            .collect::<Vec<_>>()
    };
    let mut lines = Vec::new();
    if !collapsible.is_empty() {
        let status = overall_status(collapsible.iter().copied());
        let active = matches!(status, ToolStatus::Pending | ToolStatus::Running);
        let mut summary = summarize_tools(&collapsible, !active);
        if active {
            summary.push('…');
        }
        let mut spans = vec![
            Span::raw("  "),
            Span::styled(
                format!("{} ", status_icon(status, spinner_frame)),
                status_style(status, theme),
            ),
            Span::styled(
                truncate(&summary, width.saturating_sub(8)),
                Style::default()
                    .fg(theme.primary)
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if let Some(elapsed) = collapsible
            .iter()
            .find(|tool| tool.status == ToolStatus::Running)
            .and_then(|tool| elapsed_label(tool))
        {
            spans.push(Span::styled(
                format!(" {elapsed}"),
                Style::default().fg(theme.secondary),
            ));
        }
        lines.push(Line::from(spans));
        if active
            && collapsible.len() > 3
            && let Some(hint) = collapsible
                .iter()
                .find(|tool| matches!(tool.status, ToolStatus::Running | ToolStatus::Pending))
                .map(|tool| description_for(tool))
                .filter(|value| !value.is_empty())
        {
            lines.push(Line::styled(
                format!("    ⎿ {}", truncate(&hint, width.saturating_sub(6))),
                Style::default().fg(theme.secondary),
            ));
        }
    }
    for tool in individual {
        lines.extend(individual_tool_lines(
            tool,
            theme,
            expanded,
            width,
            spinner_frame,
        ));
    }
    lines
}

fn summarize_tools(tools: &[&ToolCall], done: bool) -> String {
    let mut search = Vec::new();
    let mut reads = Vec::new();
    let mut lists = Vec::new();
    let mut actions = Vec::new();
    for tool in tools {
        let argument = |keys: &[&str]| {
            tool.arguments
                .as_object()
                .and_then(|map| keys.iter().find_map(|key| map.get(*key)))
                .and_then(Value::as_str)
                .unwrap_or("")
        };
        match tool_category(&tool.name) {
            ToolCategory::Search => {
                search.push(argument(&["pattern", "query", "search", "glob", "path"]).to_owned())
            }
            ToolCategory::Read => reads.push(argument(&["path", "file_path", "file"]).to_owned()),
            ToolCategory::List => lists.push(argument(&["path", "directory", "dir"]).to_owned()),
            _ => actions.push(tool_display_name(&tool.name)),
        }
    }
    let mut parts = Vec::new();
    if !search.is_empty() {
        parts.push(format!(
            "{} {}",
            if done { "Searched" } else { "Searching" },
            search.join(", ")
        ));
    }
    if !reads.is_empty() {
        parts.push(format!(
            "{} {}",
            if done { "read" } else { "reading" },
            reads.join(", ")
        ));
    }
    if !lists.is_empty() {
        parts.push(format!(
            "{} {}",
            if done { "listed" } else { "listing" },
            lists.join(", ")
        ));
    }
    if !actions.is_empty() {
        parts.push(format!(
            "{} {}",
            if done { "Ran" } else { "Running" },
            actions.join(", ")
        ));
    }
    let mut output = if parts.is_empty() {
        if done {
            "Completed tools".into()
        } else {
            "Running tools".into()
        }
    } else {
        sentence_join(parts)
    };
    if !done {
        output.push('…');
    }
    output
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolCategory {
    Search,
    Read,
    List,
    Shell,
    Edit,
    Write,
    Agent,
    Other,
}

fn normalized_tool_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn tool_category(name: &str) -> ToolCategory {
    match normalized_tool_name(name).as_str() {
        "read" | "read_file" | "hash_read" | "view" | "view_file" | "get_file" | "open_file" => {
            ToolCategory::Read
        }
        "grep"
        | "grep_search"
        | "search_file_content"
        | "ripgrep"
        | "rg"
        | "glob"
        | "find"
        | "find_files"
        | "findfiles"
        | "search"
        | "query" => ToolCategory::Search,
        "list" | "ls" | "list_directory" | "read_directory" | "read_dir" | "read_folder"
        | "ls_files" => ToolCategory::List,
        "edit" | "edit_file" | "hash_edit" | "apply_patch" | "patch" | "replace" | "notebook"
        | "notebook_edit" => ToolCategory::Edit,
        "write" | "write_file" | "create_file" => ToolCategory::Write,
        "run_shell_command" | "shell" | "bash" | "exec" | "exec_command" | "command"
        | "terminal" => ToolCategory::Shell,
        "agent" | "task" | "workflow" | "send_message" | "list_agents" | "spawn_agent"
        | "wait_agent" | "interrupt_agent" | "followup_task" | "task_create" | "task_update"
        | "task_list" | "task_stop" => ToolCategory::Agent,
        _ => ToolCategory::Other,
    }
}

fn is_collapsible(tool: &ToolCall) -> bool {
    matches!(
        tool_category(&tool.name),
        ToolCategory::Search | ToolCategory::Read | ToolCategory::List
    )
}

fn tool_display_name(name: &str) -> String {
    let normalized = normalized_tool_name(name);
    match normalized.as_str() {
        "edit" | "edit_file" | "apply_patch" | "patch" | "replace" => "Edit".into(),
        "hash_edit" => "HashEdit".into(),
        "write" | "write_file" | "create_file" => "WriteFile".into(),
        "read" | "read_file" | "view" | "view_file" | "get_file" | "open_file" => "ReadFile".into(),
        "hash_read" => "HashRead".into(),
        "zoom_image" => "ZoomImage".into(),
        "grep" | "grep_search" | "search_file_content" | "ripgrep" | "rg" => "Grep".into(),
        "glob" | "find" | "find_files" | "findfiles" => "Glob".into(),
        "run_shell_command" | "shell" | "bash" | "exec" | "exec_command" | "command"
        | "terminal" => "Shell".into(),
        "todo_write" => "TodoList".into(),
        "get_goal" => "Goal".into(),
        "update_goal" => "UpdateGoal".into(),
        "save_memory" => "SaveMemory".into(),
        "agent" | "task" => "Agent".into(),
        "workflow" => "Workflow".into(),
        "spawn_agent" => "SpawnAgent".into(),
        "wait_agent" => "WaitAgent".into(),
        "list_agents" => "ListAgents".into(),
        "send_message" => "SendMessage".into(),
        "interrupt_agent" => "InterruptAgent".into(),
        "followup_task" => "FollowupTask".into(),
        "task_create" => "TaskCreate".into(),
        "task_update" => "TaskUpdate".into(),
        "task_list" => "TaskList".into(),
        "task_stop" => "TaskStop".into(),
        "create_sub_session" => "CreateSubSession".into(),
        "team_create" => "TeamCreate".into(),
        "team_delete" => "TeamDelete".into(),
        "team_plan_approval" => "TeamPlanApproval".into(),
        "skill" => "Skill".into(),
        "enter_plan_mode" => "EnterPlanMode".into(),
        "exit_plan_mode" => "ExitPlanMode".into(),
        "web_search" => "WebSearch".into(),
        "web_fetch" => "WebFetch".into(),
        "list" | "ls" | "list_directory" | "read_directory" | "read_dir" | "read_folder"
        | "ls_files" => "ListFiles".into(),
        "lsp" => "Lsp".into(),
        "ask_user_question" => "AskUserQuestion".into(),
        "cron_create" => "CronCreate".into(),
        "cron_list" => "CronList".into(),
        "cron_delete" => "CronDelete".into(),
        "loop_wakeup" => "LoopWakeup".into(),
        "structured_output" => "StructuredOutput".into(),
        "monitor" => "Monitor".into(),
        "notebook" | "notebook_edit" => "NotebookEdit".into(),
        "tool_search" => "ToolSearch".into(),
        "read_mcp_resource" => "ReadMcpResource".into(),
        "enter_worktree" => "EnterWorktree".into(),
        "exit_worktree" => "ExitWorktree".into(),
        "artifact" => "Artifact".into(),
        "record_artifact" => "RecordArtifact".into(),
        "display_image" => "DisplayImage".into(),
        "image_gen" => "ImageGen".into(),
        _ => pascal_case_tool_name(name),
    }
}

fn pascal_case_tool_name(name: &str) -> String {
    let chars = name.trim().chars().collect::<Vec<_>>();
    let mut words = Vec::<String>::new();
    let mut word = String::new();
    for (index, ch) in chars.iter().copied().enumerate() {
        if !ch.is_ascii_alphanumeric() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            continue;
        }
        let previous = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
        let next = chars.get(index + 1).copied();
        let boundary = ch.is_ascii_uppercase()
            && !word.is_empty()
            && (previous.is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
                || (previous.is_some_and(|value| value.is_ascii_uppercase())
                    && next.is_some_and(|value| value.is_ascii_lowercase())));
        if boundary {
            words.push(std::mem::take(&mut word));
        }
        word.push(ch);
    }
    if !word.is_empty() {
        words.push(word);
    }
    if words.is_empty() {
        return "Tool".into();
    }
    words
        .into_iter()
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

fn description_for(tool: &ToolCall) -> String {
    if let Some(value) = tool.arguments.as_str() {
        let cleaned = sanitize::single_line(value);
        if matches!(cleaned.as_bytes().first(), Some(b'{' | b'['))
            && serde_json::from_str::<Value>(&cleaned)
                .is_ok_and(|value| value.is_object() || value.is_array())
        {
            return String::new();
        }
        return cleaned;
    }
    let Some(arguments) = tool.arguments.as_object() else {
        return String::new();
    };
    let keys: &[&str] = match tool_category(&tool.name) {
        ToolCategory::Search => &["pattern", "query", "search", "glob", "path"],
        ToolCategory::Shell => &["command", "cmd", "script"],
        ToolCategory::Agent => &["description", "prompt", "task", "name"],
        _ => &["path", "file_path", "file", "directory", "dir"],
    };
    keys.iter()
        .find_map(|key| arguments.get(*key).and_then(Value::as_str))
        .or_else(|| arguments.values().find_map(Value::as_str))
        .map(sanitize::single_line)
        .unwrap_or_default()
}

fn overall_status<'a>(tools: impl Iterator<Item = &'a ToolCall>) -> ToolStatus {
    let statuses = tools.map(|tool| tool.status).collect::<Vec<_>>();
    for status in [
        ToolStatus::Confirming,
        ToolStatus::Running,
        ToolStatus::Error,
        ToolStatus::Canceled,
        ToolStatus::Pending,
    ] {
        if statuses.contains(&status) {
            return status;
        }
    }
    ToolStatus::Success
}

fn status_icon(status: ToolStatus, spinner_frame: usize) -> &'static str {
    match status {
        ToolStatus::Pending => "o",
        ToolStatus::Confirming => "?",
        ToolStatus::Running => ["⊷", "⊶"][(spinner_frame / 3) % 2],
        ToolStatus::Success => "✓",
        ToolStatus::Error => "x",
        ToolStatus::Canceled => "-",
    }
}

fn status_style(status: ToolStatus, theme: &Theme) -> Style {
    let color = match status {
        ToolStatus::Error => theme.error,
        ToolStatus::Confirming | ToolStatus::Canceled => theme.warning,
        ToolStatus::Running => theme.primary,
        ToolStatus::Pending | ToolStatus::Success => theme.success,
    };
    let style = Style::default().fg(color);
    if matches!(status, ToolStatus::Error | ToolStatus::Canceled) {
        style.add_modifier(Modifier::BOLD)
    } else {
        style
    }
}

fn tool_output(tool: &ToolCall) -> String {
    if let Some(result) = &tool.result {
        if let Some(error) = &result.error {
            return sanitize::text(error);
        }
        if !result.content.is_empty() {
            return sanitize::text(&result.content);
        }
    }
    tool.updates.last().map(update_text).unwrap_or_default()
}

fn update_text(update: &Value) -> String {
    if let Some(text) = update.as_str() {
        return sanitize::text(text);
    }
    if let Some(raw) = update.as_object() {
        for key in [
            "chunk", "stdout", "stderr", "output", "content", "text", "message",
        ] {
            if let Some(text) = raw.get(key).and_then(Value::as_str) {
                return sanitize::text(text);
            }
        }
    }
    sanitize::text(&update.to_string())
}

fn elapsed_label(tool: &ToolCall) -> Option<String> {
    if tool.status != ToolStatus::Running {
        return None;
    }
    let started = tool.execution_started_ms?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let elapsed = now.saturating_sub(started);
    let timeout = tool
        .arguments
        .as_object()
        .and_then(|raw| raw.get("timeout_ms").or_else(|| raw.get("timeoutMs")))
        .and_then(Value::as_u64);
    if timeout.is_none() && elapsed < 3_000 {
        return None;
    }
    Some(if let Some(timeout) = timeout {
        format!(
            "({} · timeout {})",
            format_duration(elapsed),
            format_duration(timeout)
        )
    } else {
        format_duration(elapsed)
    })
}

fn format_duration(milliseconds: u64) -> String {
    let seconds = milliseconds / 1_000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remaining = seconds % 60;
    if minutes < 60 {
        return if remaining == 0 {
            format!("{minutes}m")
        } else {
            format!("{minutes}m {remaining}s")
        };
    }
    let hours = minutes / 60;
    let remaining = minutes % 60;
    if remaining == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {remaining}m")
    }
}

fn individual_tool_lines(
    tool: &ToolCall,
    theme: &Theme,
    expanded: bool,
    width: usize,
    spinner_frame: usize,
) -> Vec<Line<'static>> {
    let description = description_for(tool);
    let mut style = Style::default().fg(theme.primary);
    if tool.status == ToolStatus::Canceled {
        style = style.add_modifier(Modifier::CROSSED_OUT);
    }
    let mut spans = vec![
        Span::raw("  "),
        Span::styled(
            format!("{} ", status_icon(tool.status, spinner_frame)),
            status_style(tool.status, theme),
        ),
        Span::styled(
            tool_display_name(&tool.name),
            style.add_modifier(Modifier::BOLD),
        ),
    ];
    if !description.is_empty() {
        spans.push(Span::styled(
            format!(" {description}"),
            style.fg(theme.secondary),
        ));
    }
    if let Some(elapsed) = elapsed_label(tool) {
        spans.push(Span::styled(
            format!(" {elapsed}"),
            Style::default().fg(theme.secondary),
        ));
    }
    let mut lines = vec![Line::from(spans)];
    let output = tool_output(tool);
    let show_output = expanded
        || !is_collapsible(tool)
        || matches!(tool.status, ToolStatus::Error | ToolStatus::Canceled);
    if show_output && !output.is_empty() {
        let wrapped = wrap_visual(&output, width.saturating_sub(6).max(8));
        let max_lines = if expanded { wrapped.len() } else { 5 };
        let omitted = wrapped.len().saturating_sub(max_lines);
        if omitted > 0 {
            lines.push(Line::styled(
                format!("    ... first {omitted} lines hidden ..."),
                Style::default()
                    .fg(theme.secondary)
                    .add_modifier(Modifier::DIM),
            ));
        }
        let color = if tool.status == ToolStatus::Error {
            theme.error
        } else {
            theme.primary
        };
        lines.extend(
            wrapped
                .into_iter()
                .skip(omitted)
                .map(|line| Line::styled(format!("    {line}"), Style::default().fg(color))),
        );
    }
    lines
}

fn wrap_visual(value: &str, width: usize) -> Vec<String> {
    let mut output = Vec::new();
    for raw in sanitize::text(value).split('\n') {
        if raw.is_empty() {
            output.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut cells = 0usize;
        for ch in raw.chars() {
            let display = if ch == '\t' {
                "    ".to_owned()
            } else {
                ch.to_string()
            };
            let next = if ch == '\t' {
                4
            } else {
                UnicodeWidthChar::width(ch).unwrap_or(0)
            };
            if !line.is_empty() && cells + next > width {
                output.push(std::mem::take(&mut line));
                cells = 0;
            }
            line.push_str(&display);
            cells += next;
        }
        output.push(line);
    }
    output
}

fn sentence_join(parts: Vec<String>) -> String {
    let mut output = parts[0].clone();
    for part in parts.into_iter().skip(1) {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            output.push_str(", ");
            output.extend(first.to_lowercase());
            output.extend(chars);
        }
    }
    output
}

fn render_status(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    let (text, color) = if let Some(error) = app.error.as_deref() {
        (error, app.theme.error)
    } else {
        (app.notice.as_deref().unwrap_or(""), app.theme.link)
    };
    frame.render_widget(
        Paragraph::new(Line::styled(
            format!("  {text}"),
            Style::default().fg(color),
        )),
        area,
    );
}

fn render_loading(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if area.height == 0 || !app.busy() {
        return;
    }
    let timer = format!(
        "({} · esc to cancel)",
        crate::loading::format_elapsed(app.loading_elapsed_seconds())
    );
    if area.width <= 30 {
        frame.render_widget(
            Paragraph::new(Line::styled(
                format!("  {timer}"),
                Style::default().fg(app.theme.secondary),
            )),
            area,
        );
        return;
    }

    let dots_frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let tmux_frames = [". ", ".."];
    let spinner = if std::env::var_os("TMUX").is_some() {
        tmux_frames[(app.spinner_frame / 9) % tmux_frames.len()]
    } else {
        dots_frames[app.spinner_frame % dots_frames.len()]
    };
    let status_spans = vec![
        Span::raw("  "),
        Span::styled(spinner, Style::default().fg(app.theme.primary)),
        Span::raw(" "),
        Span::styled(app.loading_phrase(), Style::default().fg(app.theme.accent)),
    ];
    if area.width < 80 {
        frame.render_widget(
            Paragraph::new(Text::from(vec![
                Line::from(status_spans),
                Line::styled(
                    format!("  {timer}"),
                    Style::default().fg(app.theme.secondary),
                ),
            ])),
            area,
        );
    } else {
        let mut spans = status_spans;
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            timer,
            Style::default().fg(app.theme.secondary),
        ));
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }
}

fn render_queue(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    let items = app
        .projection
        .as_ref()
        .map(|p| p.queue.as_slice())
        .unwrap_or_default();
    let mut lines = items
        .iter()
        .take(3)
        .map(|item| {
            Line::styled(
                format!(
                    "  {}",
                    truncate(
                        &sanitize::single_line(&item.message),
                        area.width.saturating_sub(2) as usize
                    )
                ),
                Style::default().fg(app.theme.secondary),
            )
        })
        .collect::<Vec<_>>();
    if items.len() > 3 {
        lines.push(Line::styled(
            format!("  ... (+{} more)", items.len() - 3),
            Style::default().fg(app.theme.secondary),
        ));
    }
    lines.push(Line::styled(
        "  Ctrl+Q to queue",
        Style::default()
            .fg(app.theme.secondary)
            .add_modifier(Modifier::ITALIC),
    ));
    lines.truncate(area.height as usize);
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_confirmation_wait(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::raw("  "),
            Span::styled("⠏ ", Style::default().fg(app.theme.primary)),
            Span::styled(
                "Waiting for confirmation",
                Style::default().fg(app.theme.secondary),
            ),
        ])),
        area,
    );
}

fn render_composer(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if area.height < 3 {
        return;
    }
    frame.render_widget(
        Paragraph::new(Line::styled(
            "─".repeat(area.width as usize),
            Style::default().fg(app.theme.focused),
        )),
        Rect::new(area.x, area.y, area.width, 1),
    );
    let input_rows = input_rows(app, area.width);
    let input_area = Rect::new(area.x, area.y + 1, area.width, input_rows);
    let bottom = Rect::new(area.x, area.y + 1 + input_rows, area.width, 1);
    if app.editor.is_empty() {
        let mut spans = vec![Span::styled("> ", Style::default().fg(app.theme.accent))];
        spans.push(Span::styled(
            " ",
            Style::default()
                .bg(app.theme.primary)
                .fg(app.theme.background),
        ));
        spans.push(Span::styled(
            if app.exiting {
                " Exiting…"
            } else {
                " Type your message or @path/to/file"
            },
            Style::default().fg(app.theme.secondary),
        ));
        frame.render_widget(Paragraph::new(Line::from(spans)), input_area);
    } else {
        let (visual_lines, cursor_line) = input_visual_layout(app, area.width);
        let visible_start = cursor_line
            .saturating_add(1)
            .saturating_sub(INPUT_VIEWPORT_ROWS);
        let visible_end = visible_start
            .saturating_add(INPUT_VIEWPORT_ROWS)
            .min(visual_lines.len());
        let mut lines = Vec::new();
        for (index, visual) in visual_lines[visible_start..visible_end].iter().enumerate() {
            let visual_index = visible_start + index;
            let line = &app.editor.text()[visual.start..visual.end];
            let cursor_here = visual_index == cursor_line;
            let prefix = Span::styled(
                if visual_index == 0 { "> " } else { "  " },
                Style::default().fg(app.theme.accent),
            );
            if cursor_here {
                let relative = app.editor.cursor().saturating_sub(visual.start);
                let before = &line[..relative];
                let rest = &line[relative..];
                let cursor = rest.graphemes(true).next().unwrap_or(" ");
                let after = if rest.is_empty() {
                    ""
                } else {
                    &rest[cursor.len()..]
                };
                lines.push(Line::from(vec![
                    prefix,
                    Span::styled(before.to_owned(), Style::default().fg(app.theme.primary)),
                    Span::styled(
                        cursor.to_owned(),
                        Style::default()
                            .fg(app.theme.background)
                            .bg(app.theme.primary),
                    ),
                    Span::styled(after.to_owned(), Style::default().fg(app.theme.primary)),
                ]));
            } else {
                lines.push(Line::from(vec![
                    prefix,
                    Span::styled(line.to_owned(), Style::default().fg(app.theme.primary)),
                ]));
            }
        }
        frame.render_widget(Paragraph::new(lines), input_area);
    }
    frame.render_widget(
        Paragraph::new(Line::styled(
            "─".repeat(area.width as usize),
            Style::default().fg(app.theme.focused),
        )),
        bottom,
    );
    let suggestions = app.command_suggestions();
    if !suggestions.is_empty() {
        let suggestion_area = Rect::new(
            area.x.saturating_add(2),
            bottom.y.saturating_add(1),
            area.width.saturating_sub(4),
            area.height.saturating_sub(input_rows + 2),
        );
        let visible = suggestion_area.height.min(8) as usize;
        let selected = app
            .suggestion_index
            .min(suggestions.len().saturating_sub(1));
        let start = selected.saturating_sub(visible.saturating_sub(1));
        let lines = suggestions
            .iter()
            .enumerate()
            .skip(start)
            .take(visible)
            .map(|(index, (name, description))| {
                let active = index == selected;
                Line::from(vec![
                    Span::styled(
                        if active { "> " } else { "  " },
                        Style::default().fg(if active {
                            app.theme.accent
                        } else {
                            app.theme.secondary
                        }),
                    ),
                    Span::styled(
                        format!("/{name:<18}"),
                        Style::default().fg(if active {
                            app.theme.accent
                        } else {
                            app.theme.secondary
                        }),
                    ),
                    Span::styled(
                        description.clone(),
                        Style::default().fg(if active {
                            app.theme.accent
                        } else {
                            app.theme.secondary
                        }),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), suggestion_area);
    }
}

fn render_footer(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let left = if app.focused_tool_group.is_some() {
        "Tool focus · ↑↓ navigate · Enter expand · Esc close"
    } else if app.busy() {
        "Enter to steer · Ctrl+Q to queue"
    } else {
        "? for shortcuts · Ctrl+T tools"
    };
    frame.render_widget(
        Paragraph::new(Line::styled(
            format!("  {left}"),
            Style::default().fg(app.theme.secondary),
        )),
        area,
    );
}

fn extension_rows(app: &App, placement: &str, max_rows: u16) -> u16 {
    let Some(projection) = app.projection.as_ref() else {
        return 0;
    };
    let widget_count = projection
        .widgets
        .values()
        .filter(|value| widget_placement(value) == placement)
        .count();
    let other = if placement == "above-editor" {
        projection.notifications.len().min(2)
    } else {
        projection.statuses.len()
    };
    ((widget_count + other) as u16).min(max_rows)
}

fn render_extensions(frame: &mut Frame<'_>, app: &App, area: Rect, placement: &str) {
    if area.height == 0 {
        return;
    }
    let projection = app.projection.as_ref().expect("projection");
    let mut lines = Vec::new();
    if placement == "above-editor" {
        for notification in projection
            .notifications
            .iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let color = match notification.level.as_str() {
                "error" => app.theme.error,
                "warning" | "warn" => app.theme.warning,
                _ => app.theme.link,
            };
            lines.push(Line::styled(
                format!("  {}", sanitize::single_line(&notification.text)),
                Style::default().fg(color),
            ));
        }
    }
    for value in projection.widgets.values() {
        if widget_placement(value) == placement {
            let text = value
                .as_object()
                .and_then(|raw| raw.get("value"))
                .map(display_json)
                .unwrap_or_else(|| display_json(value));
            if !text.is_empty() {
                lines.push(Line::styled(
                    format!("  {text}"),
                    Style::default().fg(app.theme.secondary),
                ));
            }
        }
    }
    if placement == "below-editor" {
        for (name, value) in &projection.statuses {
            let text = value
                .as_object()
                .and_then(|raw| raw.get("value"))
                .map(display_json)
                .unwrap_or_else(|| display_json(value));
            if !text.is_empty() {
                lines.push(Line::styled(
                    format!("  {name}: {text}"),
                    Style::default().fg(app.theme.secondary),
                ));
            }
        }
    }
    lines.truncate(area.height as usize);
    frame.render_widget(Paragraph::new(lines), area);
}

fn widget_placement(value: &Value) -> &str {
    value
        .as_object()
        .and_then(|raw| raw.get("options"))
        .and_then(Value::as_object)
        .and_then(|raw| raw.get("placement"))
        .and_then(Value::as_str)
        .unwrap_or("above-editor")
}

fn display_json(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => sanitize::text(text),
        Value::Array(values) => values
            .iter()
            .map(display_json)
            .collect::<Vec<_>>()
            .join(" · "),
        Value::Object(_) => sanitize::text(&serde_json::to_string(value).unwrap_or_default()),
        other => other.to_string(),
    }
}

fn render_dialog(frame: &mut Frame<'_>, app: &App, area: Rect) {
    frame.render_widget(Clear, area);
    let inner = inset(area, 2, 0);
    if let Some(selector) = app.selector.as_ref() {
        let block = Block::default()
            .title(format!(" {} ", selector.title))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(app.theme.focused));
        let body = block.inner(inner);
        frame.render_widget(block, inner);
        if selector.kind == SelectorKind::Theme && body.width >= 70 {
            let columns =
                Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
                    .split(body);
            render_selector_list(frame, app, columns[0]);
            render_theme_preview(frame, app, columns[1]);
        } else {
            render_selector_list(frame, app, body);
        }
        return;
    }
    if let Some(interaction) = app.active_interaction() {
        let block = Block::default()
            .title(format!(" {} ", interaction.title))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(app.theme.focused));
        let body = block.inner(inner);
        frame.render_widget(block, inner);
        let mut lines = vec![
            Line::styled(
                sanitize::text(&interaction.message),
                Style::default().fg(app.theme.primary),
            ),
            Line::raw(""),
        ];
        if matches!(interaction.kind.as_str(), "input" | "custom") {
            let value = app.dialog_editor.text();
            let display = if value.is_empty() {
                interaction.placeholder.as_deref().unwrap_or("Type a value")
            } else {
                value
            };
            lines.push(Line::from(vec![
                Span::styled("> ", Style::default().fg(app.theme.accent)),
                Span::styled(
                    sanitize::text(display),
                    Style::default().fg(if value.is_empty() {
                        app.theme.secondary
                    } else {
                        app.theme.primary
                    }),
                ),
            ]));
        }
        for (index, item) in interaction.items.iter().enumerate() {
            let selected = index == app.dialog_selected;
            lines.push(Line::styled(
                format!(
                    "{} {}. {}",
                    if selected { ">" } else { " " },
                    index + 1,
                    sanitize::single_line(&item.label)
                ),
                Style::default().fg(if selected {
                    app.theme.accent
                } else {
                    app.theme.secondary
                }),
            ));
        }
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            "Use ↑↓ or j/k to navigate, Enter to select, Esc to cancel",
            Style::default().fg(app.theme.secondary),
        ));
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
    }
}

fn render_selector_list(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let selector = app.selector.as_ref().expect("selector");
    let visible = area.height.saturating_sub(2) as usize;
    let start = selector.selected.saturating_sub(visible.saturating_sub(1));
    let lines = selector
        .options
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(index, (label, _))| {
            let selected = index == selector.selected;
            Line::styled(
                format!(
                    "{} {:>2}. {}",
                    if selected { ">" } else { " " },
                    index + 1,
                    sanitize::single_line(label)
                ),
                Style::default().fg(if selected {
                    app.theme.accent
                } else {
                    app.theme.secondary
                }),
            )
        })
        .chain(std::iter::once(Line::styled(
            "↑↓ navigate · Enter select · Esc cancel",
            Style::default().fg(app.theme.secondary),
        )))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_theme_preview(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let block = Block::default()
        .title(" Preview ")
        .borders(Borders::LEFT)
        .border_style(Style::default().fg(app.theme.secondary))
        .style(Style::default().bg(app.theme.background));
    let body = block.inner(area);
    frame.render_widget(block, area);
    let lines = vec![
        Line::styled(
            format!("  {}", app.theme.name),
            Style::default()
                .fg(app.theme.accent)
                .add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
        Line::from(vec![
            Span::styled("  fn ", Style::default().fg(app.theme.accent)),
            Span::styled("main", Style::default().fg(app.theme.link)),
            Span::raw("() {"),
        ]),
        Line::styled(
            "      let message = \"Hello, Qwen!\";",
            Style::default().fg(app.theme.primary),
        ),
        Line::styled("  +   added line", Style::default().fg(app.theme.success)),
        Line::styled("  -   removed line", Style::default().fg(app.theme.error)),
        Line::raw("  }"),
    ];
    frame.render_widget(Paragraph::new(lines), body);
}

fn truncate(value: &str, width: usize) -> String {
    if value.width() <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "…".repeat(width);
    }
    let mut out = String::new();
    for grapheme in value.graphemes(true) {
        if out.width() + grapheme.width() + 1 > width {
            break;
        }
        out.push_str(grapheme);
    }
    out.push('…');
    out
}

fn shorten_path(value: &str, width: usize) -> String {
    let home = std::env::var("HOME").ok();
    let value = home
        .as_deref()
        .and_then(|home| value.strip_prefix(home).map(|suffix| format!("~{suffix}")))
        .unwrap_or_else(|| value.to_owned());
    if value.width() <= width {
        return value;
    }
    let left = width.saturating_sub(1).div_ceil(2);
    let right = width.saturating_sub(1) / 2;
    format!(
        "{}…{}",
        value.chars().take(left).collect::<String>(),
        value
            .chars()
            .rev()
            .take(right)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )
}

fn inset(area: Rect, horizontal: u16, vertical: u16) -> Rect {
    Rect::new(
        area.x.saturating_add(horizontal),
        area.y.saturating_add(vertical),
        area.width.saturating_sub(horizontal.saturating_mul(2)),
        area.height.saturating_sub(vertical.saturating_mul(2)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use pretty_assertions::assert_eq;
    use ratatui::{
        Terminal, TerminalOptions, Viewport,
        backend::{Backend, TestBackend},
        layout::Position,
        widgets::Widget,
    };
    use serde_json::json;

    fn frame(app: &App, width: u16, height: u16) -> String {
        let mut app = app.clone();
        frame_with_state(&mut app, width, height)
    }

    fn frame_with_state(app: &mut App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn buffer_text(buffer: &ratatui::buffer::Buffer) -> String {
        buffer_rect_text(buffer, buffer.area)
    }

    fn buffer_rect_text(buffer: &ratatui::buffer::Buffer, area: Rect) -> String {
        (area.y..area.bottom())
            .map(|y| {
                (area.x..area.right())
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn fixture() -> App {
        let mut projection = UiProjection::default();
        projection.state.phase = "idle".into();
        projection.models = Some(ModelList {
            current: Some(Model {
                id: "qwen".into(),
                provider: Some("Plugin".into()),
                model: Some("default".into()),
                description: None,
            }),
            providers: vec![],
        });
        projection.history = vec![
            HistoryItem::User {
                id: "u".into(),
                text: "hello".into(),
            },
            HistoryItem::Assistant {
                id: "a".into(),
                text: "TUI is ready. Ctrl+N inserts a newline; Enter submits.".into(),
                reasoning: None,
                streaming: false,
            },
        ];
        let mut app = App::with_projection(projection);
        app.cwd = "/workspace/qi-agent".into();
        app
    }

    #[test]
    fn inline_content_height_shrinks_when_idle_and_grows_with_live_content() {
        let mut app = fixture();
        app.inline_mode = true;
        app.header_committed = true;
        app.committed_history_count = app.projection.as_ref().unwrap().history.len();

        assert_eq!(inline_content_height(&app, 100), 4);

        app.editor.set_text("first\nsecond\nthird");
        assert_eq!(inline_content_height(&app, 100), 6);

        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::Assistant {
                id: "streaming".into(),
                text: "A response that is still streaming".into(),
                reasoning: None,
                streaming: true,
            });
        assert!(inline_content_height(&app, 100) >= 9);
    }

    #[test]
    fn inline_content_height_includes_suggestions_and_dialog_content() {
        let mut app = fixture();
        app.inline_mode = true;
        app.header_committed = true;
        app.committed_history_count = app.projection.as_ref().unwrap().history.len();
        app.commands = vec![
            ("model".into(), "Select model".into()),
            ("models".into(), "List models".into()),
        ];
        app.editor.set_text("/mo");
        assert_eq!(inline_content_height(&app, 100), 6);

        app.selector = Some(crate::app::Selector {
            kind: SelectorKind::Model,
            title: "Select model".into(),
            options: (0..8)
                .map(|index| (format!("model-{index}"), json!(index)))
                .collect(),
            selected: 0,
            original_theme: None,
        });
        assert_eq!(inline_content_height(&app, 100), 15);
    }

    #[test]
    fn composer_uses_visual_unicode_rows_and_keeps_a_ten_row_cursor_viewport() {
        let mut app = fixture();
        app.inline_mode = true;
        app.header_committed = true;
        app.committed_history_count = app.projection.as_ref().unwrap().history.len();
        app.editor.set_text(format!("{}尾", "你".repeat(50)));

        let (lines, cursor_line) = input_visual_layout(&app, 12);
        assert_eq!(lines.len(), 11);
        assert_eq!(cursor_line, 10);
        assert_eq!(input_rows(&app, 12), 10);
        assert_eq!(inline_content_height(&app, 12), 13);
        assert!(
            lines
                .iter()
                .all(|line| { app.editor.text()[line.start..line.end].width() <= 10 })
        );
        assert_eq!(lines[cursor_line].end, app.editor.text().len());
    }

    #[test]
    fn streaming_markdown_only_splits_after_complete_blocks() {
        let source = "first\n\n```rust\nlet x = 1;\n\nstill fenced\n```\n\nlast";
        let boundaries = safe_markdown_boundaries(source);
        assert_eq!(boundaries.len(), 2);
        assert_eq!(&source[..boundaries[0]], "first\n\n");
        assert_eq!(
            &source[..boundaries[1]],
            "first\n\n```rust\nlet x = 1;\n\nstill fenced\n```\n\n"
        );
    }

    #[test]
    fn streaming_assistant_commits_safe_prefix_without_repeating_it_at_finalization() {
        let mut app = fixture();
        app.inline_mode = true;
        app.header_committed = true;
        app.committed_history_count = app.projection.as_ref().unwrap().history.len();
        let text = concat!(
            "ALPHA is the first complete block.\n\n",
            "BRAVO is the second complete block.\n\n",
            "CHARLIE is the third complete block.\n\n",
            "DELTA remains live until the message finishes."
        );
        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::Assistant {
                id: "stream:run".into(),
                text: text.into(),
                reasoning: None,
                streaming: true,
            });

        let candidate = streaming_commit_candidate(&app, 30, 9).expect("safe prefix");
        assert!(candidate.state.committed_text.contains("ALPHA"));
        assert!(candidate.state.committed_text.ends_with("\n\n"));
        assert_eq!(
            candidate
                .lines
                .iter()
                .flat_map(|line| &line.spans)
                .filter(|span| span.content.as_ref() == "◆ ")
                .count(),
            1
        );
        let committed_prefix = candidate.state.committed_text.clone();
        app.record_inline_stream_commit(candidate.state);
        assert!(inline_transcript_rows(&app, 30) > 0);

        let envelope: Envelope = serde_json::from_value(json!({
            "type":"event",
            "event":"message",
            "event_id":"final-answer",
            "data":{"message":{"role":"assistant","content":text}}
        }))
        .unwrap();
        app.apply_envelope(&envelope);
        let state = app
            .inline_stream_commit
            .as_ref()
            .expect("reconciled prefix");
        assert_eq!(state.item_id, "final-answer");
        assert_eq!(state.committed_text, committed_prefix);

        let start = app.committed_history_count;
        let end = app.committable_history_end();
        let lines = committed_lines(&app, start, end, false, true, 30);
        assert!(lines.first().is_some_and(|line| line.width() == 0));
        assert!(
            !lines
                .iter()
                .flat_map(|line| &line.spans)
                .any(|span| span.content.as_ref() == "◆ ")
        );
        let remaining = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(!remaining.contains("ALPHA"), "{remaining}");
        assert!(remaining.contains("DELTA"), "{remaining}");
    }

    #[test]
    fn idle_frame_matches_qwen_shell_at_160x44() {
        let output = frame(&fixture(), 160, 44);
        assert!(output.contains("___ ___     _   ___ ___ _  _ _____"));
        assert!(output.contains(">_ qì agent (v0.1.0)"));
        assert!(output.contains("Tips: Type / to see all available commands."));
        assert!(output.contains("> hello"));
        assert!(output.contains("◆ TUI is ready. Ctrl+N inserts a newline; Enter submits."));
        assert!(output.contains("Type your message or @path/to/file"));
        assert!(output.contains("? for shortcuts"));
        assert_eq!(output.lines().count(), 44);
    }

    #[test]
    fn narrow_frame_hides_logo_without_clipping_controls() {
        let output = frame(&fixture(), 80, 24);
        assert!(!output.contains("___ ___"));
        assert!(output.contains(">_ qì agent"));
        assert!(output.contains("Type your message or @path/to/file"));
        assert!(output.lines().all(|line| line.width() <= 80));
    }

    #[test]
    fn busy_frame_shows_the_humorous_phrase_timer_and_cancel_hint() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().state.phase = "model".into();
        app.loading_phrase_index = 0;
        app.busy_since = Some(std::time::Instant::now());

        let wide = frame(&app, 160, 44);
        assert!(wide.replace(' ', "").contains("正在努力搬砖，请稍候..."));
        assert!(wide.contains("(0s · esc to cancel)"));

        let narrow = frame(&app, 60, 24);
        assert!(narrow.replace(' ', "").contains("正在努力搬砖，请稍候..."));
        assert!(narrow.contains("(0s · esc to cancel)"));
    }

    #[test]
    fn inline_viewport_moves_final_history_to_terminal_scrollback() {
        let mut app = fixture();
        app.inline_mode = true;
        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::ToolGroup {
                id: "active".into(),
                batch_key: None,
                tools: vec![ToolCall {
                    call_id: "shell".into(),
                    name: "exec_command".into(),
                    arguments: json!({"cmd":"cargo test"}),
                    status: ToolStatus::Running,
                    updates: vec![json!({"stdout":"still running"})],
                    ..ToolCall::default()
                }],
            });
        let end = app.committable_history_end();
        assert_eq!(end, 2);

        let mut backend = TestBackend::new(80, 12);
        backend.set_cursor_position(Position::new(0, 6)).unwrap();
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(6),
            },
        )
        .unwrap();
        let lines = committed_lines(&app, 0, end, true, false, 80);
        let height = committed_height(&lines, 80);
        terminal
            .insert_before(height, move |buffer| {
                Paragraph::new(Text::from(lines))
                    .wrap(Wrap { trim: false })
                    .render(buffer.area, buffer);
            })
            .unwrap();
        app.header_committed = true;
        app.committed_history_count = end;
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();

        let viewport_area = terminal.current_buffer_mut().area;
        let scrollback = buffer_text(terminal.backend().scrollback());
        let screen = buffer_text(terminal.backend().buffer());
        let viewport = buffer_rect_text(terminal.backend().buffer(), viewport_area);
        assert!(scrollback.contains(">_ qì agent"));
        assert!(format!("{scrollback}\n{screen}").contains("> hello"));
        assert!(!viewport.contains("> hello"));
        assert!(!viewport.contains("TUI is ready"));
        assert!(viewport.contains("Shell cargo test"), "{viewport}");
        assert!(viewport.contains("still running"), "{viewport}");
        assert!(!viewport.lines().any(|line| line.ends_with('#')));
    }

    #[test]
    fn dialog_replaces_composer_and_preserves_history() {
        let mut app = fixture();
        app.selector = Some(crate::app::Selector {
            kind: SelectorKind::Model,
            title: "Select model".into(),
            options: vec![
                ("qwen-coder".into(), json!("qwen")),
                ("local-coder".into(), json!("local")),
            ],
            selected: 0,
            original_theme: None,
        });
        let output = frame(&app, 100, 30);
        assert!(output.contains("> hello"));
        assert!(output.contains("Select model"));
        assert!(output.contains(">  1. qwen-coder"));
        assert!(!output.contains("Type your message"));
        assert!(!output.contains("? for shortcuts"));
    }

    #[test]
    fn inline_dialog_tolerates_a_very_short_terminal() {
        let mut app = fixture();
        app.inline_mode = true;
        app.selector = Some(crate::app::Selector {
            kind: SelectorKind::Model,
            title: "Select model".into(),
            options: vec![("qwen-coder".into(), json!("qwen"))],
            selected: 0,
            original_theme: None,
        });
        let output = frame(&app, 60, 6);
        assert_eq!(output.lines().count(), 6);
    }

    #[test]
    fn tool_batch_uses_one_mixed_past_tense_summary() {
        let mut app = fixture();
        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::ToolGroup {
                id: "t".into(),
                batch_key: Some("step-1".into()),
                tools: vec![
                    ToolCall {
                        call_id: "g".into(),
                        name: "grep".into(),
                        arguments: json!({"pattern":"ToolGroup"}),
                        status: ToolStatus::Success,
                        ..ToolCall::default()
                    },
                    ToolCall {
                        call_id: "r".into(),
                        name: "read".into(),
                        arguments: json!({"path":"README.md"}),
                        status: ToolStatus::Success,
                        ..ToolCall::default()
                    },
                    ToolCall {
                        call_id: "l".into(),
                        name: "ls".into(),
                        arguments: json!({"path":"apps/tui-rs/src"}),
                        status: ToolStatus::Success,
                        ..ToolCall::default()
                    },
                ],
            });
        let output = frame(&app, 160, 44);
        assert_eq!(
            output
                .matches("Searched ToolGroup, read README.md, listed apps/tui-rs/src")
                .count(),
            1
        );
    }

    #[test]
    fn slash_suggestions_and_multiline_editor_follow_qwen_chrome() {
        let mut app = fixture();
        app.commands = vec![
            ("model".into(), "Select model".into()),
            ("sessions".into(), "Resume session".into()),
        ];
        app.editor.insert("/m");
        let suggestions = frame(&app, 100, 30);
        assert!(suggestions.contains("> /model"));
        assert!(suggestions.contains("Select model"));

        app.editor.set_text("first\nsecond");
        let multiline = frame(&app, 100, 30);
        assert!(multiline.contains("> first"));
        assert!(multiline.contains("  second"));
    }

    #[test]
    fn renders_extension_notifications_widgets_and_statuses_in_their_slots() {
        let mut app = fixture();
        let projection = app.projection.as_mut().unwrap();
        projection.notifications.push(Notification {
            id: "n".into(),
            text: "Index refreshed".into(),
            level: "info".into(),
        });
        projection.widgets.insert(
            "above".into(),
            json!({"value":"Repository ready","options":{"placement":"above-editor"}}),
        );
        projection.widgets.insert(
            "below".into(),
            json!({"value":"Safe mode","options":{"placement":"below-editor"}}),
        );
        projection
            .statuses
            .insert("lsp".into(), json!({"value":"ready"}));
        let output = frame(&app, 100, 32);
        assert!(output.contains("Index refreshed"));
        assert!(output.contains("Repository ready"));
        assert!(output.contains("Safe mode"));
        assert!(output.contains("lsp: ready"));
    }

    #[test]
    fn assistant_markdown_uses_qwen_blocks_without_raw_markers() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().history = vec![HistoryItem::Assistant {
            id: "markdown".into(),
            text: "## Result\n- **bold**\n[link](https://example.com)\n```rust\nfn main() {}\n```"
                .into(),
            reasoning: None,
            streaming: false,
        }];
        let output = frame(&app, 100, 30);
        assert!(output.contains("Result"));
        assert!(output.contains("- bold"));
        assert!(output.contains("link (https://example.com)"));
        assert!(output.contains("rust"));
        assert!(output.contains("fn main() {}"));
        assert!(!output.contains("## Result"));
        assert!(!output.contains("**bold**"));
        assert!(!output.contains("```"));
    }

    #[test]
    fn tool_names_and_descriptions_match_semantic_renderer_contract() {
        assert_eq!(tool_display_name("hash_read"), "HashRead");
        assert_eq!(tool_display_name("XMLParser"), "XMLParser");
        assert_eq!(tool_display_name("myCustom-tool"), "MyCustomTool");

        let mut app = fixture();
        app.projection.as_mut().unwrap().history = vec![HistoryItem::ToolGroup {
            id: "descriptions".into(),
            batch_key: None,
            tools: vec![
                ToolCall {
                    call_id: "long".into(),
                    name: "agent".into(),
                    arguments: json!({
                        "description": format!(
                            "{}FINAL-DESCRIPTION-MARKER",
                            "inspect every relevant module carefully ".repeat(3)
                        )
                    }),
                    status: ToolStatus::Success,
                    ..ToolCall::default()
                },
                ToolCall {
                    call_id: "json".into(),
                    name: "calculate".into(),
                    arguments: json!("{\"secret\":true}"),
                    status: ToolStatus::Success,
                    ..ToolCall::default()
                },
            ],
        }];
        let output = frame(&app, 52, 28);
        assert!(output.contains("FINAL-DESCRIPTION-MARKER"));
        assert!(output.contains("Calculate"));
        assert!(!output.contains("secret"));
    }

    #[test]
    fn action_tools_show_live_output_elapsed_timeout_and_complete_expansion() {
        let mut app = fixture();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::ToolGroup {
                id: "actions".into(),
                batch_key: Some("step".into()),
                tools: vec![ToolCall {
                    call_id: "shell".into(),
                    name: "exec_command".into(),
                    arguments: json!({"cmd":"cargo test","timeout_ms":10_000}),
                    status: ToolStatus::Running,
                    updates: vec![json!({"stdout":"latest live output"})],
                    execution_started_ms: Some(now),
                    ..ToolCall::default()
                }],
            });
        let output = frame(&app, 120, 34);
        assert!(output.contains("Shell cargo test"));
        assert!(output.contains("latest live output"));
        assert!(output.contains("timeout 10s"));

        if let Some(HistoryItem::ToolGroup { tools, .. }) =
            app.projection.as_mut().unwrap().history.last_mut()
        {
            tools[0].status = ToolStatus::Success;
            tools[0].result = Some(ToolResult {
                ok: true,
                content: (1..=8)
                    .map(|index| format!("line {index}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                ..ToolResult::default()
            });
        }
        app.details_expanded = true;
        let expanded = frame(&app, 120, 34);
        assert!(expanded.contains("line 1"));
        assert!(expanded.contains("line 8"));
        assert!(!expanded.contains("lines hidden"));
    }

    #[test]
    fn queue_shows_three_previews_overflow_and_hint() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().queue = (1..=5)
            .map(|index| QueueItem {
                id: index.to_string(),
                kind: "follow-up".into(),
                message: format!("queued   message\n{index}"),
            })
            .collect();
        let output = frame(&app, 100, 30);
        assert!(output.contains("queued message 1"));
        assert!(output.contains("queued message 3"));
        assert!(!output.contains("queued message 4"));
        assert!(output.contains("... (+2 more)"));
        assert!(output.contains("Ctrl+Q to queue"));
    }

    #[test]
    fn approval_dialog_has_a_static_waiting_row() {
        let mut app = fixture();
        app.projection
            .as_mut()
            .unwrap()
            .interactions
            .push(Interaction {
                id: "approval".into(),
                kind: "approval".into(),
                title: "Confirm".into(),
                message: "Allow command?".into(),
                items: vec![InteractionChoice {
                    label: "Allow".into(),
                    value: json!("allow"),
                }],
                ..Interaction::default()
            });
        let output = frame(&app, 100, 30);
        assert!(output.contains("⠏ Waiting for confirmation"));
        assert!(output.contains("Allow command?"));
    }

    #[test]
    fn long_history_renders_a_row_virtualized_window_and_scrollbar() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().history = (1..=60)
            .map(|index| HistoryItem::Assistant {
                id: format!("answer-{index}"),
                text: format!("answer {index}"),
                reasoning: None,
                streaming: false,
            })
            .collect();
        let output = frame_with_state(&mut app, 80, 24);
        assert!(output.contains("answer 60"));
        assert!(!output.contains("answer 1\n"));
        assert!(output.lines().any(|line| line.ends_with('█')));
        assert!(output.lines().count() == 24);

        app.history_viewport.scroll_by(-40);
        let scrolled = frame_with_state(&mut app, 80, 24);
        assert!(scrolled.contains("answer 40"));
        assert!(!scrolled.contains("answer 60"));
    }

    #[test]
    fn one_long_message_scrolls_by_physical_row() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().history = vec![HistoryItem::Assistant {
            id: "long-answer".into(),
            text: (1..=60)
                .map(|index| format!("line {index:02}"))
                .collect::<Vec<_>>()
                .join("\n"),
            reasoning: None,
            streaming: false,
        }];
        let bottom = frame_with_state(&mut app, 80, 24);
        assert!(bottom.contains("line 60"));
        let bottom_offset = app.history_viewport.scroll_top();

        app.history_viewport.scroll_by(-1);
        let scrolled = frame_with_state(&mut app, 80, 24);
        assert_eq!(app.history_viewport.scroll_top(), bottom_offset - 1);
        assert!(!scrolled.contains("line 60"));
        assert!(scrolled.contains("line 59"));
    }

    #[test]
    fn new_output_does_not_move_a_scrolled_virtual_viewport() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().history = (1..=40)
            .map(|index| HistoryItem::Assistant {
                id: format!("answer-{index}"),
                text: format!("answer {index}"),
                reasoning: None,
                streaming: false,
            })
            .collect();
        frame_with_state(&mut app, 80, 24);
        app.history_viewport.scroll_by(-20);
        let before = frame_with_state(&mut app, 80, 24);
        let before_top = app.history_viewport.scroll_top();
        let visible_before = (1..=40)
            .filter(|index| before.contains(&format!("answer {index}")))
            .collect::<Vec<_>>();

        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::Assistant {
                id: "streaming".into(),
                text: (1..=20)
                    .map(|index| format!("new line {index}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                reasoning: None,
                streaming: true,
            });
        let after = frame_with_state(&mut app, 80, 24);
        assert_eq!(app.history_viewport.scroll_top(), before_top);
        let visible_after = (1..=40)
            .filter(|index| after.contains(&format!("answer {index}")))
            .collect::<Vec<_>>();
        assert_eq!(visible_before, visible_after);
        assert!(!after.contains("new line"));
    }

    #[test]
    fn ten_thousand_items_only_measure_the_visible_window() {
        let mut app = fixture();
        app.projection.as_mut().unwrap().history = (1..=10_000)
            .map(|index| HistoryItem::Assistant {
                id: format!("answer-{index}"),
                text: format!("answer {index}"),
                reasoning: None,
                streaming: false,
            })
            .collect();

        let output = frame_with_state(&mut app, 80, 24);
        assert!(output.contains("answer 10000"));
        assert!(app.history_viewport.cached_height_count() < 64);
    }

    #[test]
    fn focused_tool_group_is_marked_and_untrusted_text_is_sanitized() {
        let mut app = fixture();
        app.projection
            .as_mut()
            .unwrap()
            .history
            .push(HistoryItem::ToolGroup {
                id: "focused".into(),
                batch_key: None,
                tools: vec![ToolCall {
                    call_id: "bad".into(),
                    name: "exec_command".into(),
                    arguments: json!({"cmd":"\u{1b}[31mecho safe\u{1b}[0m"}),
                    status: ToolStatus::Error,
                    result: Some(ToolResult {
                        error: Some("\u{1b}]0;owned\u{7}failure".into()),
                        ..ToolResult::default()
                    }),
                    ..ToolCall::default()
                }],
            });
        app.focused_tool_group = Some(app.projection.as_ref().unwrap().history.len() - 1);
        let output = frame(&app, 100, 30);
        assert!(output.contains("› x Shell echo safe"));
        assert!(output.contains("failure"));
        assert!(!output.contains("[31m"));
        assert!(!output.contains("]0;owned"));
    }
}
