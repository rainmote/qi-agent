/// Remove terminal escape sequences, unsafe control characters, and bidi
/// overrides before untrusted model/tool/plugin text reaches the terminal.
pub fn text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let mut previous_escape = false;
                    for next in chars.by_ref() {
                        if next == '\u{7}' || (previous_escape && next == '\\') {
                            break;
                        }
                        previous_escape = next == '\u{1b}';
                    }
                }
                Some('(' | ')') => {
                    let _ = chars.next();
                }
                Some(_) | None => {}
            }
            continue;
        }
        if matches!(ch, '\n' | '\t') {
            output.push(ch);
            continue;
        }
        if ch.is_control() || matches!(ch as u32, 0x202a..=0x202e | 0x2066..=0x2069) {
            continue;
        }
        output.push(ch);
    }
    output.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn single_line(value: &str) -> String {
    text(value).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_terminal_controls_and_bidi_overrides() {
        assert_eq!(
            text("ok\u{1b}[31m red\u{1b}[0m\u{0}\u{202e}safe\nnext"),
            "ok redsafe\nnext"
        );
        assert_eq!(single_line("  one\n\ttwo  "), "one two");
    }
}
