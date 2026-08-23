use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Editor {
    text: String,
    cursor: usize,
    preferred_column: Option<usize>,
    history: Vec<String>,
    history_index: Option<usize>,
    draft: String,
}

impl Editor {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let cursor = text.len();
        Self {
            text,
            cursor,
            ..Self::default()
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.preferred_column = None;
        self.history_index = None;
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.cursor = self.text.len();
        self.preferred_column = None;
    }

    pub fn insert(&mut self, value: &str) {
        let value = value.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.cursor, &value);
        self.cursor += value.len();
        self.preferred_column = None;
        self.history_index = None;
    }

    pub fn newline(&mut self) {
        self.insert("\n");
    }

    pub fn left(&mut self) {
        if let Some((index, _)) = self.text[..self.cursor].grapheme_indices(true).next_back() {
            self.cursor = index;
        }
        self.preferred_column = None;
    }

    pub fn right(&mut self) {
        if let Some(grapheme) = self.text[self.cursor..].graphemes(true).next() {
            self.cursor += grapheme.len();
        }
        self.preferred_column = None;
    }

    pub fn home(&mut self) {
        self.cursor = self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        self.preferred_column = None;
    }

    pub fn end(&mut self) {
        self.cursor = self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |index| self.cursor + index);
        self.preferred_column = None;
    }

    pub fn backspace(&mut self) {
        let previous = self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(index, _)| index);
        if let Some(previous) = previous {
            self.text.replace_range(previous..self.cursor, "");
            self.cursor = previous;
            self.preferred_column = None;
            self.history_index = None;
        }
    }

    pub fn delete(&mut self) {
        if let Some(grapheme) = self.text[self.cursor..].graphemes(true).next() {
            self.text
                .replace_range(self.cursor..self.cursor + grapheme.len(), "");
            self.preferred_column = None;
            self.history_index = None;
        }
    }

    pub fn up(&mut self) {
        let line_start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        if line_start == 0 {
            self.history(-1);
            return;
        }
        let current_column = self.text[line_start..self.cursor].graphemes(true).count();
        let column = *self.preferred_column.get_or_insert(current_column);
        let previous_end = line_start - 1;
        let previous_start = self.text[..previous_end].rfind('\n').map_or(0, |i| i + 1);
        self.cursor =
            byte_at_grapheme(&self.text[previous_start..previous_end], column) + previous_start;
    }

    pub fn down(&mut self) {
        let line_start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        let Some(relative_end) = self.text[self.cursor..].find('\n') else {
            self.history(1);
            return;
        };
        let current_column = self.text[line_start..self.cursor].graphemes(true).count();
        let column = *self.preferred_column.get_or_insert(current_column);
        let next_start = self.cursor + relative_end + 1;
        let next_end = self.text[next_start..]
            .find('\n')
            .map_or(self.text.len(), |i| next_start + i);
        self.cursor = byte_at_grapheme(&self.text[next_start..next_end], column) + next_start;
    }

    pub fn submit(&mut self) -> Option<String> {
        if self.text.trim().is_empty() {
            return None;
        }
        let value = self.text.clone();
        if self.history.last() != Some(&value) {
            self.history.push(value.clone());
        }
        self.clear();
        Some(value)
    }

    pub fn history(&mut self, direction: i8) {
        if self.history.is_empty() {
            return;
        }
        if direction < 0 {
            if self.history_index.is_none() {
                self.draft = self.text.clone();
            }
            let next = self
                .history_index
                .map_or(self.history.len() - 1, |i| i.saturating_sub(1));
            self.history_index = Some(next);
            self.set_text(self.history[next].clone());
            self.history_index = Some(next);
        } else if let Some(index) = self.history_index {
            if index + 1 >= self.history.len() {
                self.history_index = None;
                self.set_text(self.draft.clone());
            } else {
                self.history_index = Some(index + 1);
                self.set_text(self.history[index + 1].clone());
                self.history_index = Some(index + 1);
            }
        }
    }

    pub fn cursor_parts(&self) -> (&str, &str, &str) {
        let line_start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        let line_end = self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |i| self.cursor + i);
        let grapheme = self.text[self.cursor..line_end]
            .graphemes(true)
            .next()
            .unwrap_or(" ");
        (
            &self.text[line_start..self.cursor],
            grapheme,
            &self.text[self.cursor
                + if grapheme == " " && self.cursor == line_end {
                    0
                } else {
                    grapheme.len()
                }..line_end],
        )
    }
}

fn byte_at_grapheme(text: &str, column: usize) -> usize {
    text.grapheme_indices(true)
        .nth(column)
        .map_or(text.len(), |(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_unicode_by_grapheme() {
        let mut editor = Editor::new("A😀e\u{301}");
        editor.backspace();
        assert_eq!(editor.text(), "A😀");
        editor.left();
        editor.delete();
        assert_eq!(editor.text(), "A");
    }

    #[test]
    fn preserves_draft_across_history() {
        let mut editor = Editor::new("first");
        assert_eq!(editor.submit().as_deref(), Some("first"));
        editor.set_text("draft");
        editor.up();
        assert_eq!(editor.text(), "first");
        editor.down();
        assert_eq!(editor.text(), "draft");
    }

    #[test]
    fn normalizes_paste_line_endings_and_preserves_vertical_column() {
        let mut editor = Editor::new("");
        editor.insert("12345\r\nx\r12345");
        assert_eq!(editor.text(), "12345\nx\n12345");

        editor.up();
        assert_eq!(editor.cursor(), "12345\nx".len());
        editor.up();
        assert_eq!(editor.cursor(), "12345".len());
        editor.down();
        editor.down();
        assert_eq!(editor.cursor(), editor.text().len());
    }
}
