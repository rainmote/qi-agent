use crate::{
    editor::Editor,
    loading,
    model::*,
    projection, sanitize,
    theme::{self, Theme},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEventKind};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Rpc { method: &'static str, params: Value },
    Exit,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SelectorKind {
    Model,
    Theme,
    Session,
    Tree,
    Command,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Selector {
    pub kind: SelectorKind,
    pub title: String,
    pub options: Vec<(String, Value)>,
    pub selected: usize,
    pub original_theme: Option<String>,
}

#[derive(Clone, Debug)]
pub struct App {
    pub projection: Option<UiProjection>,
    pub editor: Editor,
    pub commands: Vec<(String, String)>,
    pub suggestion_index: usize,
    pub selector: Option<Selector>,
    pub dialog_selected: usize,
    pub dialog_editor: Editor,
    pub dialog_interaction_id: Option<String>,
    pub theme: Theme,
    pub cwd: PathBuf,
    pub brand: String,
    pub version: String,
    pub details_expanded: bool,
    pub expanded_tool_groups: HashSet<String>,
    pub focused_tool_group: Option<usize>,
    pub inline_mode: bool,
    pub header_committed: bool,
    pub committed_history_count: usize,
    pub scroll_offset: usize,
    pub follow_bottom: bool,
    pub notice: Option<String>,
    pub error: Option<String>,
    pub exiting: bool,
    pub spinner_frame: usize,
    pub busy_since: Option<Instant>,
    pub loading_active_since: Option<Instant>,
    pub loading_accumulated: Duration,
    pub loading_phrase_index: usize,
    pub last_ctrl_c: Option<Instant>,
}

impl Default for App {
    fn default() -> Self {
        Self {
            projection: None,
            editor: Editor::default(),
            commands: Vec::new(),
            suggestion_index: 0,
            selector: None,
            dialog_selected: 0,
            dialog_editor: Editor::default(),
            dialog_interaction_id: None,
            theme: Theme::default(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            brand: "bb-agent".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            details_expanded: false,
            expanded_tool_groups: HashSet::new(),
            focused_tool_group: None,
            inline_mode: false,
            header_committed: false,
            committed_history_count: 0,
            scroll_offset: 0,
            follow_bottom: true,
            notice: None,
            error: None,
            exiting: false,
            spinner_frame: 0,
            busy_since: None,
            loading_active_since: None,
            loading_accumulated: Duration::ZERO,
            loading_phrase_index: 0,
            last_ctrl_c: None,
        }
    }
}

impl App {
    pub fn with_projection(projection: UiProjection) -> Self {
        let mut app = Self {
            projection: Some(projection),
            ..Self::default()
        };
        app.sync_theme();
        app.sync_busy_indicator();
        app
    }

    pub fn busy(&self) -> bool {
        self.projection
            .as_ref()
            .is_some_and(|p| p.state.phase != "idle")
    }

    pub fn active_interaction(&self) -> Option<&Interaction> {
        self.projection.as_ref()?.interactions.first()
    }

    pub fn has_dialog(&self) -> bool {
        self.active_interaction().is_some() || self.selector.is_some()
    }

    pub fn command_suggestions(&self) -> Vec<&(String, String)> {
        let value = self.editor.text();
        if !value.starts_with('/')
            || value.contains(char::is_whitespace)
            || self.editor.cursor() != value.len()
        {
            return Vec::new();
        }
        let query = value.trim_start_matches('/').to_ascii_lowercase();
        self.commands
            .iter()
            .filter(|(name, _)| name.to_ascii_lowercase().starts_with(&query))
            .collect()
    }

    pub fn tick(&mut self) {
        self.spinner_frame = self.spinner_frame.wrapping_add(1);
    }

    pub fn loading_elapsed_seconds(&self) -> u64 {
        (self.loading_accumulated
            + self
                .loading_active_since
                .map_or(Duration::ZERO, |started| started.elapsed()))
        .as_secs()
    }

    pub fn loading_phrase(&self) -> &'static str {
        let rotation = self
            .busy_since
            .map_or(0, |started| started.elapsed().as_secs())
            / loading::PHRASE_CHANGE_INTERVAL_SECS;
        loading::phrase(
            self.loading_phrase_index
                .wrapping_add(rotation as usize * 31),
        )
    }

    pub fn handle_paste(&mut self, text: &str) {
        if self
            .active_interaction()
            .is_some_and(|interaction| matches!(interaction.kind.as_str(), "input" | "custom"))
        {
            self.dialog_editor.insert(text);
        } else if self.selector.is_none() {
            self.editor.insert(text);
        }
    }

    pub fn handle_mouse(&mut self, kind: MouseEventKind) -> bool {
        if self.inline_mode {
            return false;
        }
        match kind {
            MouseEventKind::ScrollUp => {
                self.scroll_history_up(1);
                true
            }
            MouseEventKind::ScrollDown => {
                self.scroll_history_down(1);
                true
            }
            _ => false,
        }
    }

    pub fn load_snapshot(&mut self, value: Value) -> anyhow::Result<()> {
        self.projection = Some(projection::from_snapshot(serde_json::from_value(value)?));
        self.sync_theme();
        self.sync_busy_indicator();
        Ok(())
    }

    pub fn load_commands(&mut self, value: Value) {
        self.commands = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let raw = entry.as_object()?;
                let name = raw
                    .get("name")?
                    .as_str()?
                    .trim_start_matches('/')
                    .to_owned();
                let description = raw
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                Some((name, description))
            })
            .collect();
        self.commands.sort_by(|a, b| a.0.cmp(&b.0));
    }

    pub fn apply_envelope(&mut self, envelope: &Envelope) {
        if let Some(current) = self.projection.take() {
            self.projection = Some(projection::apply_envelope(current, envelope));
            self.sync_theme();
            self.sync_busy_indicator();
        }
    }

    pub fn handle_rpc_result(&mut self, method: &str, result: Value) {
        match method {
            "session.snapshot" => {
                if let Err(error) = self.load_snapshot(result) {
                    self.error = Some(error.to_string());
                }
            }
            "command.list" => self.load_commands(result),
            "ui.shortcut.invoke" => {
                if result
                    .as_object()
                    .and_then(|raw| raw.get("invoked"))
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    self.error = Some(
                        result
                            .as_object()
                            .and_then(|raw| raw.get("error"))
                            .and_then(Value::as_object)
                            .and_then(|raw| raw.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Shortcut failed")
                            .to_owned(),
                    );
                }
            }
            "model.list" => {
                if let Ok(models) = serde_json::from_value::<ModelList>(result) {
                    let initial = models
                        .current
                        .as_ref()
                        .and_then(|current| {
                            models.providers.iter().position(|p| p.id == current.id)
                        })
                        .unwrap_or(0);
                    self.selector = Some(Selector {
                        kind: SelectorKind::Model,
                        title: "Select model".into(),
                        options: models
                            .providers
                            .into_iter()
                            .map(|model| {
                                let label = [model.provider.as_deref(), model.model.as_deref()]
                                    .into_iter()
                                    .flatten()
                                    .collect::<Vec<_>>()
                                    .join(" | ");
                                (
                                    if label.is_empty() {
                                        model.id.clone()
                                    } else {
                                        label
                                    },
                                    Value::String(model.id),
                                )
                            })
                            .collect(),
                        selected: initial,
                        original_theme: None,
                    });
                }
            }
            "model.select" => {
                if let (Some(p), Ok(model)) = (
                    self.projection.as_mut(),
                    serde_json::from_value::<Model>(result),
                ) {
                    p.models.get_or_insert_with(ModelList::default).current = Some(model);
                }
                self.selector = None;
            }
            "frontend.exit" => self.exiting = true,
            "command.execute" => {
                if let Some(name) = result
                    .as_object()
                    .and_then(|raw| raw.get("theme"))
                    .and_then(Value::as_str)
                {
                    self.theme = theme::named(name);
                    if let Some(projection) = self.projection.as_mut() {
                        projection.theme = Some(name.to_owned());
                    }
                }
                if let Some(ui) = result
                    .as_object()
                    .and_then(|raw| raw.get("ui"))
                    .and_then(Value::as_str)
                {
                    let kind = match ui {
                        "session-selector" => Some((SelectorKind::Session, "Resume session")),
                        "tree-selector" => Some((SelectorKind::Tree, "Session tree")),
                        "model-selector" => Some((SelectorKind::Model, "Select model")),
                        _ => None,
                    };
                    if let Some((kind, title)) = kind {
                        let source = result
                            .as_object()
                            .and_then(|raw| raw.get("output"))
                            .unwrap_or(&Value::Null);
                        self.selector = Some(Selector {
                            kind,
                            title: title.into(),
                            options: selection_options(source),
                            selected: 0,
                            original_theme: None,
                        });
                        return;
                    }
                }
                if let Some(output) = result.as_object().and_then(|raw| raw.get("output")) {
                    let text = display_value(output);
                    if !text.is_empty()
                        && let Some(projection) = self.projection.as_mut()
                    {
                        projection.history.push(HistoryItem::Info {
                            id: format!("command:{}", projection.history.len()),
                            text,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    pub fn handle_rpc_error(&mut self, message: impl Into<String>) {
        self.error = Some(message.into());
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Vec<Action> {
        self.error = None;
        if self.has_dialog() {
            return self.handle_dialog_key(key);
        }
        if let Some(shortcut) = shortcut_name(key)
            && self
                .projection
                .as_ref()
                .is_some_and(|projection| projection.shortcuts.contains_key(&shortcut))
        {
            return vec![Action::Rpc {
                method: "ui.shortcut.invoke",
                params: json!({"shortcut":shortcut}),
            }];
        }
        if self.focused_tool_group.is_some() {
            return self.handle_tool_focus_key(key);
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('t' | 'T'))
        {
            self.focused_tool_group = self.tool_group_indices().last().copied();
            if self.focused_tool_group.is_none() {
                self.notice = Some("No tool groups in this session".into());
            }
            return vec![];
        }
        if matches!(key.code, KeyCode::PageUp) {
            if self.inline_mode {
                return vec![];
            }
            self.scroll_history_up(5);
            return vec![];
        }
        if matches!(key.code, KeyCode::PageDown) {
            if self.inline_mode {
                return vec![];
            }
            self.scroll_history_down(5);
            return vec![];
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('o' | 'O'))
        {
            self.details_expanded = !self.details_expanded;
            return vec![];
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('c' | 'C'))
        {
            if self.busy() {
                return vec![Action::Rpc {
                    method: "turn.abort",
                    params: json!({}),
                }];
            }
            self.editor.clear();
            let now = Instant::now();
            if self
                .last_ctrl_c
                .is_some_and(|at| now.duration_since(at) <= Duration::from_millis(500))
            {
                return vec![Action::Rpc {
                    method: "frontend.exit",
                    params: json!({}),
                }];
            }
            self.last_ctrl_c = Some(now);
            self.notice = Some("再按一次 Ctrl+C 退出".into());
            return vec![];
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('d' | 'D'))
        {
            if self.editor.is_empty() {
                return vec![Action::Rpc {
                    method: "frontend.exit",
                    params: json!({}),
                }];
            }
            self.editor.delete();
            return vec![];
        }
        if matches!(key.code, KeyCode::Esc) {
            if self.busy() {
                return vec![Action::Rpc {
                    method: "turn.abort",
                    params: json!({}),
                }];
            }
            self.editor.clear();
            return vec![];
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('q' | 'Q'))
        {
            if self.busy() {
                return self.submit(true);
            }
            return vec![];
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('a' | 'A') => {
                    self.editor.home();
                    return vec![];
                }
                KeyCode::Char('e' | 'E') => {
                    self.editor.end();
                    return vec![];
                }
                KeyCode::Char('n' | 'N') => {
                    self.editor.newline();
                    return vec![];
                }
                _ => {}
            }
        }
        if matches!(key.code, KeyCode::Enter) {
            if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL | KeyModifiers::SHIFT)
            {
                self.editor.newline();
                return vec![];
            }
            let suggestions = self.command_suggestions();
            let exact = suggestions
                .iter()
                .any(|(name, _)| self.editor.text().eq_ignore_ascii_case(&format!("/{name}")));
            if !exact && !suggestions.is_empty() {
                self.accept_suggestion();
                return vec![];
            }
            return self.submit(false);
        }
        let suggestions_len = self.command_suggestions().len();
        if suggestions_len > 0 {
            match key.code {
                KeyCode::Up => {
                    self.suggestion_index = self
                        .suggestion_index
                        .checked_sub(1)
                        .unwrap_or(suggestions_len - 1);
                    return vec![];
                }
                KeyCode::Down => {
                    self.suggestion_index = (self.suggestion_index + 1) % suggestions_len;
                    return vec![];
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::Left => self.editor.left(),
            KeyCode::Right => self.editor.right(),
            KeyCode::Up => self.editor.up(),
            KeyCode::Down => self.editor.down(),
            KeyCode::Home => self.editor.home(),
            KeyCode::End => self.editor.end(),
            KeyCode::Backspace => self.editor.backspace(),
            KeyCode::Delete => self.editor.delete(),
            KeyCode::Tab => self.accept_suggestion(),
            KeyCode::Char(ch)
                if !key.modifiers.intersects(
                    KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                ) =>
            {
                self.editor.insert(&ch.to_string());
                self.suggestion_index = 0;
            }
            _ => {}
        }
        if let Some(index) = self.focused_tool_group {
            let history_len = self
                .projection
                .as_ref()
                .map_or(0, |projection| projection.history.len());
            self.scroll_offset = history_len.saturating_sub(index + 1);
            self.follow_bottom = self.scroll_offset == 0;
        }
        vec![]
    }

    fn tool_group_indices(&self) -> Vec<usize> {
        self.projection
            .as_ref()
            .map(|projection| {
                projection
                    .history
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| {
                        matches!(item, HistoryItem::ToolGroup { .. }).then_some(index)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn scroll_history_up(&mut self, amount: usize) {
        let maximum = self
            .projection
            .as_ref()
            .map_or(0, |projection| projection.history.len().saturating_sub(1));
        self.scroll_offset = self.scroll_offset.saturating_add(amount).min(maximum);
        self.follow_bottom = self.scroll_offset == 0;
    }

    fn scroll_history_down(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
        self.follow_bottom = self.scroll_offset == 0;
    }

    pub fn committable_history_end(&self) -> usize {
        let Some(projection) = self.projection.as_ref() else {
            return 0;
        };
        let start = self.committed_history_count.min(projection.history.len());
        projection.history[start..]
            .iter()
            .position(|item| !item.is_final())
            .map_or(projection.history.len(), |offset| start + offset)
    }

    fn handle_tool_focus_key(&mut self, key: KeyEvent) -> Vec<Action> {
        let indices = self.tool_group_indices();
        if indices.is_empty() {
            self.focused_tool_group = None;
            return vec![];
        }
        let current = self
            .focused_tool_group
            .unwrap_or(indices[indices.len() - 1]);
        let position = indices
            .iter()
            .position(|index| *index == current)
            .unwrap_or(0);
        match key.code {
            KeyCode::Esc => self.focused_tool_group = None,
            KeyCode::Up | KeyCode::Char('k') => {
                self.focused_tool_group = Some(indices[position.saturating_sub(1)]);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.focused_tool_group = Some(indices[(position + 1).min(indices.len() - 1)]);
            }
            KeyCode::Left => {
                if let Some(id) = self.focused_tool_group_id() {
                    self.expanded_tool_groups.remove(&id);
                }
            }
            KeyCode::Right => {
                if let Some(id) = self.focused_tool_group_id() {
                    self.expanded_tool_groups.insert(id);
                }
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                if let Some(id) = self.focused_tool_group_id()
                    && !self.expanded_tool_groups.remove(&id)
                {
                    self.expanded_tool_groups.insert(id);
                }
            }
            _ => {}
        }
        vec![]
    }

    fn focused_tool_group_id(&self) -> Option<String> {
        let index = self.focused_tool_group?;
        self.projection
            .as_ref()?
            .history
            .get(index)
            .map(|item| item.id().to_owned())
    }

    fn submit(&mut self, deferred: bool) -> Vec<Action> {
        let Some(text) = self.editor.submit() else {
            return vec![];
        };
        if text.starts_with('/') {
            return self.command(&text);
        }
        let method = if deferred {
            "turn.follow-up"
        } else if self.busy() {
            "turn.steer"
        } else {
            "turn.submit"
        };
        vec![Action::Rpc {
            method,
            params: json!({"message": text}),
        }]
    }

    fn command(&mut self, text: &str) -> Vec<Action> {
        let mut parts = text.trim().splitn(2, char::is_whitespace);
        let name = parts.next().unwrap_or_default().trim_start_matches('/');
        let argument = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match name {
            "quit" => vec![Action::Rpc {
                method: "frontend.exit",
                params: json!({}),
            }],
            "model" if argument.is_none() => vec![Action::Rpc {
                method: "model.list",
                params: json!({}),
            }],
            "model" => vec![Action::Rpc {
                method: "model.select",
                params: json!({"provider": argument}),
            }],
            "theme" if argument.is_none() => {
                let original = self
                    .projection
                    .as_ref()
                    .and_then(|p| p.theme.clone())
                    .unwrap_or_else(|| self.theme.name.into());
                let options = theme::THEME_NAMES
                    .iter()
                    .map(|name| {
                        (
                            (*name).to_owned(),
                            Value::String(if name.starts_with("Auto") {
                                "auto".into()
                            } else {
                                (*name).into()
                            }),
                        )
                    })
                    .collect();
                self.selector = Some(Selector {
                    kind: SelectorKind::Theme,
                    title: "Select Theme".into(),
                    options,
                    selected: 2,
                    original_theme: Some(original),
                });
                vec![]
            }
            "theme" => vec![Action::Rpc {
                method: "command.execute",
                params: json!({"command": text}),
            }],
            _ => vec![Action::Rpc {
                method: "command.execute",
                params: json!({"command": text}),
            }],
        }
    }

    fn accept_suggestion(&mut self) {
        let name = self
            .command_suggestions()
            .get(self.suggestion_index)
            .map(|(name, _)| name.clone());
        if let Some(name) = name {
            self.editor.set_text(format!("/{name} "));
            self.suggestion_index = 0;
        }
    }

    fn handle_dialog_key(&mut self, key: KeyEvent) -> Vec<Action> {
        if let Some(mut selector) = self.selector.take() {
            let mut keep_open = true;
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    selector.selected = selector.selected.saturating_sub(1)
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    selector.selected =
                        (selector.selected + 1).min(selector.options.len().saturating_sub(1))
                }
                KeyCode::Esc => {
                    if let Some(original) = selector.original_theme.as_deref() {
                        self.theme = theme::named(original);
                    }
                    keep_open = false;
                }
                KeyCode::Enter => {
                    let kind = selector.kind.clone();
                    let value = selector
                        .options
                        .get(selector.selected)
                        .map(|(_, value)| value.clone())
                        .unwrap_or(Value::Null);
                    if kind == SelectorKind::Theme {
                        let name = value.as_str().unwrap_or("Qwen Dark");
                        self.theme = theme::named(name);
                        return vec![Action::Rpc {
                            method: "command.execute",
                            params: json!({"command": format!("/theme {name}")}),
                        }];
                    }
                    if kind == SelectorKind::Model {
                        return vec![Action::Rpc {
                            method: "model.select",
                            params: json!({"provider": value}),
                        }];
                    }
                    if kind == SelectorKind::Session {
                        return vec![Action::Rpc {
                            method: "frontend.exit",
                            params: json!({"outcome":{"next-session":value}}),
                        }];
                    }
                    if kind == SelectorKind::Tree {
                        let event_id = value.as_str().unwrap_or_default();
                        return vec![Action::Rpc {
                            method: "command.execute",
                            params: json!({"command":format!("/checkout {event_id}")}),
                        }];
                    }
                }
                _ => {}
            }
            if selector.kind == SelectorKind::Theme
                && let Some(name) = selector
                    .options
                    .get(selector.selected)
                    .and_then(|(_, value)| value.as_str())
            {
                self.theme = theme::named(name);
            }
            if keep_open {
                self.selector = Some(selector);
            }
            return vec![];
        }
        let Some(interaction) = self.active_interaction().cloned() else {
            return vec![];
        };
        if self.dialog_interaction_id.as_deref() != Some(&interaction.id) {
            self.dialog_interaction_id = Some(interaction.id.clone());
            self.dialog_selected = interaction
                .items
                .iter()
                .position(|item| item.value == interaction.default)
                .unwrap_or(0);
            let initial = interaction.default.as_str().unwrap_or_default();
            self.dialog_editor.set_text(initial);
        }
        if matches!(interaction.kind.as_str(), "input" | "custom") {
            match key.code {
                KeyCode::Esc if !interaction.required => {
                    return vec![Action::Rpc {
                        method: "ui.prompt.resolve",
                        params: json!({"id": interaction.id, "cancelled":true}),
                    }];
                }
                KeyCode::Enter => {
                    let text = self.dialog_editor.text().to_owned();
                    if interaction.required && text.trim().is_empty() {
                        self.error = Some("This prompt requires a value".into());
                        return vec![];
                    }
                    let value = if interaction.kind == "custom" {
                        match serde_json::from_str::<Value>(&text) {
                            Ok(value) => value,
                            Err(error) => {
                                self.error = Some(format!("Invalid JSON: {error}"));
                                return vec![];
                            }
                        }
                    } else {
                        Value::String(text)
                    };
                    return vec![Action::Rpc {
                        method: "ui.prompt.resolve",
                        params: json!({"id":interaction.id,"value":value}),
                    }];
                }
                KeyCode::Left => self.dialog_editor.left(),
                KeyCode::Right => self.dialog_editor.right(),
                KeyCode::Home => self.dialog_editor.home(),
                KeyCode::End => self.dialog_editor.end(),
                KeyCode::Backspace => self.dialog_editor.backspace(),
                KeyCode::Delete => self.dialog_editor.delete(),
                KeyCode::Char(ch)
                    if !key.modifiers.intersects(
                        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                    ) =>
                {
                    self.dialog_editor.insert(&ch.to_string())
                }
                _ => {}
            }
            return vec![];
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.dialog_selected = self.dialog_selected.saturating_sub(1);
                vec![]
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.dialog_selected =
                    (self.dialog_selected + 1).min(interaction.items.len().saturating_sub(1));
                vec![]
            }
            KeyCode::Esc if interaction.kind == "approval" => vec![Action::Rpc {
                method: "interaction.resolve",
                params: json!({"id": interaction.id, "decision":"deny"}),
            }],
            KeyCode::Esc if !interaction.required => vec![Action::Rpc {
                method: "ui.prompt.resolve",
                params: json!({"id": interaction.id, "cancelled":true}),
            }],
            KeyCode::Enter => {
                let value = interaction
                    .items
                    .get(self.dialog_selected)
                    .map(|item| item.value.clone())
                    .unwrap_or(interaction.default);
                let method = if interaction.kind == "approval" {
                    "interaction.resolve"
                } else {
                    "ui.prompt.resolve"
                };
                let key = if interaction.kind == "approval" {
                    "decision"
                } else {
                    "value"
                };
                let mut params = serde_json::Map::new();
                params.insert("id".into(), Value::String(interaction.id));
                params.insert(key.into(), value);
                vec![Action::Rpc {
                    method,
                    params: Value::Object(params),
                }]
            }
            _ => vec![],
        }
    }

    fn sync_theme(&mut self) {
        if let Some(name) = self.projection.as_ref().and_then(|p| p.theme.as_deref()) {
            self.theme = theme::named(name);
        }
    }

    fn sync_busy_indicator(&mut self) {
        if self.busy() {
            if self.busy_since.is_none() {
                let time_seed = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos() as usize;
                let run_seed = self
                    .projection
                    .as_ref()
                    .and_then(|projection| projection.state.run_id.as_deref())
                    .unwrap_or_default()
                    .bytes()
                    .fold(0usize, |seed, byte| {
                        seed.wrapping_mul(31).wrapping_add(byte as usize)
                    });
                self.loading_phrase_index = (time_seed ^ run_seed) % loading::PHRASES.len();
                let now = Instant::now();
                self.busy_since = Some(now);
                self.loading_accumulated = Duration::ZERO;
                self.loading_active_since = (self
                    .projection
                    .as_ref()
                    .is_none_or(|projection| projection.state.phase != "tool"))
                .then_some(now);
                self.spinner_frame = 0;
            } else if self
                .projection
                .as_ref()
                .is_some_and(|projection| projection.state.phase == "tool")
            {
                if let Some(started) = self.loading_active_since.take() {
                    self.loading_accumulated += started.elapsed();
                }
            } else if self.loading_active_since.is_none() {
                self.loading_active_since = Some(Instant::now());
            }
        } else {
            self.busy_since = None;
            self.loading_active_since = None;
            self.loading_accumulated = Duration::ZERO;
            self.spinner_frame = 0;
        }
    }
}

fn shortcut_name(key: KeyEvent) -> Option<String> {
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && let KeyCode::Char(ch) = key.code
    {
        return Some(format!("ctrl+{}", ch.to_lowercase()));
    }
    if key.modifiers.contains(KeyModifiers::ALT) && key.code == KeyCode::Enter {
        return Some("alt+enter".into());
    }
    match key.code {
        KeyCode::Tab => Some("tab".into()),
        KeyCode::Esc => Some("escape".into()),
        KeyCode::Enter => Some("enter".into()),
        _ => None,
    }
}

fn selection_options(value: &Value) -> Vec<(String, Value)> {
    let candidates = value
        .as_array()
        .or_else(|| {
            value
                .as_object()
                .and_then(|raw| raw.get("items"))
                .and_then(Value::as_array)
        })
        .or_else(|| {
            value
                .as_object()
                .and_then(|raw| raw.get("sessions"))
                .and_then(Value::as_array)
        })
        .or_else(|| {
            value
                .as_object()
                .and_then(|raw| raw.get("entries"))
                .and_then(Value::as_array)
        });
    candidates
        .into_iter()
        .flatten()
        .map(|item| {
            if let Some(raw) = item.as_object() {
                let value = raw
                    .get("value")
                    .or_else(|| raw.get("id"))
                    .or_else(|| raw.get("path"))
                    .cloned()
                    .unwrap_or_else(|| item.clone());
                let label = raw
                    .get("label")
                    .or_else(|| raw.get("name"))
                    .or_else(|| raw.get("title"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| display_value(&value));
                (label, value)
            } else {
                (display_value(item), item.clone())
            }
        })
        .collect()
}

fn display_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => sanitize::text(text),
        Value::Array(values) => values
            .iter()
            .map(display_value)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(raw) => {
            sanitize::text(&serde_json::to_string_pretty(raw).unwrap_or_default())
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new_with_kind(code, modifiers, KeyEventKind::Press)
    }

    #[test]
    fn submit_uses_run_phase_for_steer_and_queue() {
        let mut p = UiProjection::default();
        p.state.phase = "model".into();
        let mut app = App::with_projection(p);
        app.editor.insert("now");
        assert_eq!(
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))[0],
            Action::Rpc {
                method: "turn.steer",
                params: json!({"message":"now"})
            }
        );
        app.editor.insert("later");
        assert_eq!(
            app.handle_key(key(KeyCode::Char('q'), KeyModifiers::CONTROL))[0],
            Action::Rpc {
                method: "turn.follow-up",
                params: json!({"message":"later"})
            }
        );
    }

    #[test]
    fn busy_indicator_starts_immediately_and_rotates_every_fifteen_seconds() {
        let mut projection = UiProjection::default();
        projection.state.phase = "model".into();
        let mut app = App::with_projection(projection);
        app.loading_phrase_index = 0;
        app.busy_since = Some(Instant::now());
        assert_eq!(app.loading_phrase(), loading::PHRASES[0]);

        app.busy_since = Some(Instant::now() - Duration::from_secs(15));
        assert_eq!(app.loading_phrase(), loading::PHRASES[31]);
    }

    #[test]
    fn busy_elapsed_time_pauses_during_tool_work_and_resumes_for_model_work() {
        let mut projection = UiProjection::default();
        projection.state.phase = "model".into();
        let mut app = App::with_projection(projection);
        app.loading_active_since = Some(Instant::now() - Duration::from_secs(5));

        app.projection.as_mut().unwrap().state.phase = "tool".into();
        app.sync_busy_indicator();
        let paused = app.loading_elapsed_seconds();
        assert!((5..=6).contains(&paused));
        assert!(app.loading_active_since.is_none());

        app.busy_since = Some(Instant::now() - Duration::from_secs(30));
        assert_eq!(app.loading_elapsed_seconds(), paused);

        app.projection.as_mut().unwrap().state.phase = "model".into();
        app.sync_busy_indicator();
        app.loading_active_since = Some(Instant::now() - Duration::from_secs(2));
        assert!((paused + 2..=paused + 3).contains(&app.loading_elapsed_seconds()));
    }

    #[test]
    fn inline_commits_only_the_contiguous_final_history_prefix() {
        let projection = UiProjection {
            history: vec![
                HistoryItem::User {
                    id: "user".into(),
                    text: "run it".into(),
                },
                HistoryItem::ToolGroup {
                    id: "active".into(),
                    batch_key: None,
                    tools: vec![ToolCall {
                        call_id: "tool".into(),
                        name: "exec_command".into(),
                        status: ToolStatus::Running,
                        ..ToolCall::default()
                    }],
                },
                HistoryItem::Info {
                    id: "later".into(),
                    text: "must not jump ahead".into(),
                },
            ],
            ..UiProjection::default()
        };
        let mut app = App::with_projection(projection);
        app.inline_mode = true;

        assert_eq!(app.committable_history_end(), 1);
        app.committed_history_count = 1;
        assert_eq!(app.committable_history_end(), 1);

        let HistoryItem::ToolGroup { tools, .. } = &mut app.projection.as_mut().unwrap().history[1]
        else {
            panic!("expected tool group");
        };
        tools[0].status = ToolStatus::Success;
        assert_eq!(app.committable_history_end(), 3);
    }

    #[test]
    fn theme_dialog_previews_and_rolls_back() {
        let mut app = App::with_projection(UiProjection::default());
        app.editor.insert("/theme");
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.selector.is_some());
        let before = app.theme.clone();
        app.handle_key(key(KeyCode::Down, KeyModifiers::NONE));
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.theme, before);
    }

    #[test]
    fn slash_completion_selects_and_accepts_a_filtered_command() {
        let mut app = App::with_projection(UiProjection::default());
        app.commands = vec![
            ("model".into(), "Select model".into()),
            ("sessions".into(), "Resume session".into()),
        ];
        app.editor.insert("/mo");
        assert_eq!(app.command_suggestions().len(), 1);
        assert!(
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
                .is_empty()
        );
        assert_eq!(app.editor.text(), "/model ");
    }

    #[test]
    fn command_result_opens_session_selector_and_routes_selection_to_exit() {
        let mut app = App::with_projection(UiProjection::default());
        app.handle_rpc_result(
            "command.execute",
            json!({"ui":"session-selector","output":{"sessions":[{"label":"Demo","path":"/tmp/demo.jsonl"}]}}),
        );
        assert!(matches!(
            app.selector.as_ref().map(|s| &s.kind),
            Some(SelectorKind::Session)
        ));
        assert_eq!(
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))[0],
            Action::Rpc {
                method: "frontend.exit",
                params: json!({"outcome":{"next-session":"/tmp/demo.jsonl"}})
            }
        );
    }

    #[test]
    fn approval_navigation_and_escape_use_the_remote_interaction_method() {
        let mut projection = UiProjection::default();
        projection.interactions.push(Interaction {
            id: "approval-1".into(),
            kind: "approval".into(),
            title: "Allow tool?".into(),
            items: vec![
                InteractionChoice {
                    label: "Allow".into(),
                    value: json!("allow"),
                },
                InteractionChoice {
                    label: "Deny".into(),
                    value: json!("deny"),
                },
            ],
            ..Interaction::default()
        });
        let mut app = App::with_projection(projection);
        app.handle_key(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))[0],
            Action::Rpc {
                method: "interaction.resolve",
                params: json!({"id":"approval-1","decision":"deny"})
            }
        );
    }

    #[test]
    fn custom_prompt_rejects_invalid_json_before_rpc() {
        let mut projection = UiProjection::default();
        projection.interactions.push(Interaction {
            id: "custom-1".into(),
            kind: "custom".into(),
            title: "JSON".into(),
            ..Interaction::default()
        });
        let mut app = App::with_projection(projection);
        app.handle_key(key(KeyCode::Char('{'), KeyModifiers::NONE));
        assert!(
            app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
                .is_empty()
        );
        assert!(
            app.error
                .as_deref()
                .is_some_and(|message| message.contains("Invalid JSON"))
        );
    }

    #[test]
    fn registered_shortcut_precedes_builtin_key_handling() {
        let mut projection = UiProjection::default();
        projection
            .shortcuts
            .insert("ctrl+c".into(), json!({"description":"custom"}));
        let mut app = App::with_projection(projection);
        app.editor.insert("keep me");
        assert_eq!(
            app.handle_key(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            vec![Action::Rpc {
                method: "ui.shortcut.invoke",
                params: json!({"shortcut":"ctrl+c"})
            }]
        );
        assert_eq!(app.editor.text(), "keep me");
    }

    #[test]
    fn multiline_shortcuts_and_failed_host_shortcut_follow_ui_contract() {
        let mut app = App::with_projection(UiProjection::default());
        app.editor.insert("first");
        app.handle_key(key(KeyCode::Char('n'), KeyModifiers::CONTROL));
        app.editor.insert("second");
        app.handle_key(key(KeyCode::Char('a'), KeyModifiers::CONTROL));
        app.editor.insert(">");
        app.handle_key(key(KeyCode::Char('e'), KeyModifiers::CONTROL));
        app.editor.insert("<");
        assert_eq!(app.editor.text(), "first\n>second<");

        app.handle_rpc_result(
            "ui.shortcut.invoke",
            json!({"invoked":false,"error":{"message":"shortcut exploded"}}),
        );
        assert_eq!(app.error.as_deref(), Some("shortcut exploded"));
    }

    #[test]
    fn tool_focus_toggles_one_group_and_paste_routes_to_prompt() {
        let mut projection = UiProjection::default();
        projection.history.push(HistoryItem::ToolGroup {
            id: "tools".into(),
            tools: vec![ToolCall::default()],
            batch_key: None,
        });
        let mut app = App::with_projection(projection);
        app.handle_key(key(KeyCode::Char('t'), KeyModifiers::CONTROL));
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.expanded_tool_groups.contains("tools"));
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.focused_tool_group.is_none());

        app.projection
            .as_mut()
            .unwrap()
            .interactions
            .push(Interaction {
                id: "prompt".into(),
                kind: "input".into(),
                ..Interaction::default()
            });
        app.handle_paste("pasted");
        assert_eq!(app.dialog_editor.text(), "pasted");
        assert!(app.editor.is_empty());
    }

    #[test]
    fn mouse_wheel_scrolls_history_and_clamps_at_both_ends() {
        let projection = UiProjection {
            history: (0..6)
                .map(|index| HistoryItem::Info {
                    id: format!("info-{index}"),
                    text: format!("history {index}"),
                })
                .collect(),
            ..UiProjection::default()
        };
        let mut app = App::with_projection(projection);

        assert!(app.handle_mouse(MouseEventKind::ScrollUp));
        assert_eq!(app.scroll_offset, 1);
        assert!(!app.follow_bottom);

        for _ in 0..20 {
            app.handle_mouse(MouseEventKind::ScrollUp);
        }
        assert_eq!(app.scroll_offset, 5);

        assert!(app.handle_mouse(MouseEventKind::ScrollDown));
        assert_eq!(app.scroll_offset, 4);
        for _ in 0..20 {
            app.handle_mouse(MouseEventKind::ScrollDown);
        }
        assert_eq!(app.scroll_offset, 0);
        assert!(app.follow_bottom);
        assert!(!app.handle_mouse(MouseEventKind::Moved));
    }
}
