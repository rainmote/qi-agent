use crate::{sanitize, theme::Theme};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};

pub fn render(source: &str, theme: &Theme) -> Vec<Line<'static>> {
    let source = sanitize::text(source);
    let mut output = Vec::new();
    let mut fence: Option<(char, usize, String, Vec<String>)> = None;

    for raw in source.split('\n') {
        if let Some((marker, length, language, lines)) = fence.as_mut() {
            if fence_marker(raw)
                .is_some_and(|(next, next_length, _)| next == *marker && next_length >= *length)
            {
                push_code(&mut output, language, lines, theme);
                fence = None;
            } else {
                lines.push(raw.to_owned());
            }
            continue;
        }
        if let Some((marker, length, language)) = fence_marker(raw) {
            fence = Some((marker, length, language, Vec::new()));
            continue;
        }

        let trimmed = raw.trim();
        if trimmed.is_empty() {
            if !output.is_empty() && !line_is_blank(output.last().expect("line")) {
                output.push(Line::raw(""));
            }
            continue;
        }
        if is_rule(trimmed) {
            output.push(Line::styled(
                "---",
                Style::default()
                    .fg(theme.secondary)
                    .add_modifier(Modifier::DIM),
            ));
            continue;
        }
        if let Some((level, content)) = heading(raw) {
            let mut style = Style::default().fg(theme.primary);
            if level <= 3 {
                style = style.add_modifier(Modifier::BOLD);
            } else if level == 4 {
                style = style.add_modifier(Modifier::ITALIC);
            }
            output.push(Line::from(inline(content, theme, style)));
            continue;
        }
        if let Some(content) = quote(raw) {
            let mut spans = vec![Span::styled("│ ", Style::default().fg(theme.secondary))];
            spans.extend(inline(
                content,
                theme,
                Style::default()
                    .fg(theme.primary)
                    .add_modifier(Modifier::ITALIC),
            ));
            output.push(Line::from(spans));
            continue;
        }
        if let Some((indent, marker, content, checked)) = list_item(raw) {
            let marker = match checked {
                Some(true) => "✓".to_owned(),
                Some(false) => "○".to_owned(),
                None => marker,
            };
            let mut spans = vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(
                    format!("{marker} "),
                    Style::default().fg(if checked == Some(true) {
                        theme.success
                    } else {
                        theme.primary
                    }),
                ),
            ];
            spans.extend(inline(content, theme, Style::default().fg(theme.primary)));
            output.push(Line::from(spans));
            continue;
        }
        output.push(Line::from(inline(
            raw,
            theme,
            Style::default().fg(theme.primary),
        )));
    }
    if let Some((_, _, language, lines)) = fence {
        push_code(&mut output, &language, &lines, theme);
    }
    while output.last().is_some_and(line_is_blank) {
        output.pop();
    }
    output
}

fn push_code(output: &mut Vec<Line<'static>>, language: &str, lines: &[String], theme: &Theme) {
    if !language.is_empty() {
        output.push(Line::styled(
            format!(" {language}"),
            Style::default()
                .fg(theme.secondary)
                .add_modifier(Modifier::DIM),
        ));
    }
    if lines.is_empty() {
        output.push(Line::styled(" ", Style::default().fg(theme.link)));
    } else {
        output.extend(
            lines
                .iter()
                .map(|line| Line::styled(format!(" {line}"), Style::default().fg(theme.link))),
        );
    }
}

fn line_is_blank(line: &Line<'_>) -> bool {
    line.spans.iter().all(|span| span.content.trim().is_empty())
}

fn fence_marker(line: &str) -> Option<(char, usize, String)> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let length = trimmed.chars().take_while(|ch| *ch == marker).count();
    if length < 3 {
        return None;
    }
    let language = trimmed[length..]
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned();
    Some((marker, length, language))
}

fn is_rule(value: &str) -> bool {
    let compact = value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    compact.len() >= 3
        && compact.chars().next().is_some_and(|marker| {
            matches!(marker, '-' | '_' | '*') && compact.chars().all(|ch| ch == marker)
        })
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&level) || !line[level..].starts_with(' ') {
        return None;
    }
    Some((level, line[level..].trim_start()))
}

fn quote(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    trimmed.strip_prefix('>').map(str::trim_start)
}

fn list_item(line: &str) -> Option<(usize, String, &str, Option<bool>)> {
    let indent = line.chars().take_while(|ch| ch.is_whitespace()).count();
    let rest = &line[indent..];
    let (marker, content) = if let Some(rest) = rest.strip_prefix("- ") {
        ("-".to_owned(), rest)
    } else if let Some(rest) = rest.strip_prefix("+ ") {
        ("+".to_owned(), rest)
    } else if let Some(rest) = rest.strip_prefix("* ") {
        ("*".to_owned(), rest)
    } else {
        let marker_end = rest.find(char::is_whitespace)?;
        let marker = &rest[..marker_end];
        let numeric = marker
            .strip_suffix('.')
            .or_else(|| marker.strip_suffix(')'))
            .is_some_and(|digits| {
                !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit())
            });
        if !numeric {
            return None;
        }
        (marker.to_owned(), rest[marker_end..].trim_start())
    };
    let (content, checked) = if let Some(value) = content
        .strip_prefix("[x] ")
        .or_else(|| content.strip_prefix("[X] "))
    {
        (value, Some(true))
    } else if let Some(value) = content.strip_prefix("[ ] ") {
        (value, Some(false))
    } else {
        (content, None)
    };
    Some((indent, marker, content, checked))
}

fn inline(text: &str, theme: &Theme, base: Style) -> Vec<Span<'static>> {
    let mut output = Vec::new();
    let mut plain = String::new();
    let mut cursor = 0usize;
    while cursor < text.len() {
        let rest = &text[cursor..];
        let token = if rest.starts_with("**") {
            paired(rest, "**").map(|(content, consumed)| {
                (content, consumed, base.add_modifier(Modifier::BOLD), None)
            })
        } else if rest.starts_with("__") {
            paired(rest, "__").map(|(content, consumed)| {
                (content, consumed, base.add_modifier(Modifier::BOLD), None)
            })
        } else if rest.starts_with("~~") {
            paired(rest, "~~").map(|(content, consumed)| {
                (
                    content,
                    consumed,
                    base.add_modifier(Modifier::CROSSED_OUT),
                    None,
                )
            })
        } else if rest.starts_with('`') {
            paired(rest, "`").map(|(content, consumed)| {
                (content, consumed, Style::default().fg(theme.link), None)
            })
        } else if rest.starts_with('[') {
            link(rest).map(|(label, url, consumed)| {
                (
                    label,
                    consumed,
                    Style::default()
                        .fg(theme.link)
                        .add_modifier(Modifier::UNDERLINED),
                    (label != url).then(|| format!(" ({url})")),
                )
            })
        } else if rest.starts_with('*') {
            paired(rest, "*").map(|(content, consumed)| {
                (content, consumed, base.add_modifier(Modifier::ITALIC), None)
            })
        } else if rest.starts_with('_') {
            paired(rest, "_").map(|(content, consumed)| {
                (content, consumed, base.add_modifier(Modifier::ITALIC), None)
            })
        } else {
            None
        };
        if let Some((content, consumed, style, suffix)) = token {
            if !plain.is_empty() {
                output.push(Span::styled(std::mem::take(&mut plain), base));
            }
            output.push(Span::styled(content.to_owned(), style));
            if let Some(suffix) = suffix {
                output.push(Span::styled(
                    suffix,
                    Style::default()
                        .fg(theme.secondary)
                        .add_modifier(Modifier::DIM),
                ));
            }
            cursor += consumed;
        } else {
            let ch = rest.chars().next().expect("character");
            plain.push(ch);
            cursor += ch.len_utf8();
        }
    }
    if !plain.is_empty() {
        output.push(Span::styled(plain, base));
    }
    output
}

fn paired<'a>(value: &'a str, marker: &str) -> Option<(&'a str, usize)> {
    let rest = value.strip_prefix(marker)?;
    let end = rest.find(marker)?;
    if end == 0 {
        return None;
    }
    Some((&rest[..end], marker.len() + end + marker.len()))
}

fn link(value: &str) -> Option<(&str, &str, usize)> {
    let label_end = value.find("](")?;
    let url_start = label_end + 2;
    let url_end = value[url_start..].find(')')? + url_start;
    Some((
        &value[1..label_end],
        &value[url_start..url_end],
        url_end + 1,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Modifier;

    #[test]
    fn renders_qwen_markdown_blocks_and_inline_styles() {
        let theme = Theme::default();
        let lines = render(
            "## Result\n- **bold** and [link](https://example.com)\n> quote\n```rust\nfn main() {}\n```",
            &theme,
        );
        let text = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(!text.contains("##"));
        assert!(!text.contains("**"));
        assert!(!text.contains("```"));
        assert!(text.contains("https://example.com"));
        assert!(
            lines[0].spans[0]
                .style
                .add_modifier
                .contains(Modifier::BOLD)
        );
    }
}
