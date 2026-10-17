use anyhow::{Context, Result, bail};
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyEventKind,
    },
    execute,
    terminal::{
        Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
        enable_raw_mode, size,
    },
};
use qi_agent_tui::{
    Action, App, Envelope,
    client::{self, AttachedAgent},
    daemon, service, ui, wire, worker_proxy,
};
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::CrosstermBackend,
    text::Text,
    widgets::{Paragraph, Widget, Wrap},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Write},
    os::fd::{AsRawFd, RawFd},
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

fn inline_viewport_height(content_rows: u16, terminal_rows: u16) -> u16 {
    if terminal_rows == 0 {
        content_rows.max(1)
    } else {
        content_rows.max(1).min(terminal_rows)
    }
}

enum HostMessage {
    Envelope(Box<Envelope>),
    Error(String),
    Eof,
}

#[derive(Clone)]
struct PendingRequest {
    method: String,
    params: Value,
    command_id: Option<String>,
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<File>>,
    tty: File,
    viewport_height: u16,
    mode: TerminalMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalMode {
    VirtualHistory,
    NativeScrollback,
}

/// Crossterm obtains the cursor position by writing a device-status query to
/// process stdout. Stdout is the JSONL protocol in this frontend, so direct
/// those short queries to the controlling terminal while Ratatui is drawing.
struct StdoutToTty {
    saved_stdout: RawFd,
}

impl StdoutToTty {
    fn new(tty_fd: RawFd) -> io::Result<Self> {
        // SAFETY: `dup` and `dup2` operate on process file descriptors. The
        // saved descriptor is restored and closed by Drop on every path.
        let saved_stdout = unsafe { libc::dup(libc::STDOUT_FILENO) };
        if saved_stdout < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::dup2(tty_fd, libc::STDOUT_FILENO) } < 0 {
            let error = io::Error::last_os_error();
            unsafe { libc::close(saved_stdout) };
            return Err(error);
        }
        Ok(Self { saved_stdout })
    }
}

impl Drop for StdoutToTty {
    fn drop(&mut self) {
        // SAFETY: both descriptors are valid while this guard is alive. There
        // is nothing useful to do if restoration itself fails during cleanup.
        unsafe {
            libc::dup2(self.saved_stdout, libc::STDOUT_FILENO);
            libc::close(self.saved_stdout);
        }
    }
}

impl TerminalGuard {
    fn open(mode: TerminalMode) -> Result<Self> {
        let mut tty = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .context("could not open controlling terminal /dev/tty")?;
        let mut cleanup_tty = tty
            .try_clone()
            .context("could not clone controlling terminal")?;
        let tty_fd = tty.as_raw_fd();
        let backend_tty = tty
            .try_clone()
            .context("could not clone controlling terminal for renderer")?;
        enable_raw_mode().context("could not enable terminal raw mode")?;
        let setup = match mode {
            TerminalMode::VirtualHistory => execute!(
                tty,
                EnterAlternateScreen,
                EnableMouseCapture,
                EnableBracketedPaste,
                Hide
            ),
            TerminalMode::NativeScrollback => execute!(tty, EnableBracketedPaste, Hide),
        };
        if let Err(error) = setup {
            let _ = execute!(
                cleanup_tty,
                Show,
                DisableBracketedPaste,
                DisableMouseCapture,
                LeaveAlternateScreen
            );
            let _ = disable_raw_mode();
            return Err(error).context("could not initialize terminal UI");
        }
        let initialized = match StdoutToTty::new(tty_fd).and_then(|_redirect| {
            let terminal_size = size()?;
            let (viewport, viewport_height) = match mode {
                TerminalMode::VirtualHistory => (Viewport::Fullscreen, terminal_size.1),
                TerminalMode::NativeScrollback => {
                    let height = inline_viewport_height(4, terminal_size.1);
                    (Viewport::Inline(height), height)
                }
            };
            let terminal = Terminal::with_options(
                CrosstermBackend::new(backend_tty),
                TerminalOptions { viewport },
            )?;
            Ok((terminal, viewport_height))
        }) {
            Ok(initialized) => initialized,
            Err(error) => {
                let _ = execute!(
                    cleanup_tty,
                    Show,
                    DisableBracketedPaste,
                    DisableMouseCapture,
                    LeaveAlternateScreen
                );
                let _ = disable_raw_mode();
                return Err(error).context("could not create terminal viewport");
            }
        };
        Ok(Self {
            terminal: initialized.0,
            tty,
            viewport_height: initialized.1,
            mode,
        })
    }

    fn draw(&mut self, app: &mut App) -> Result<()> {
        let _redirect = StdoutToTty::new(self.tty.as_raw_fd())?;
        self.terminal.draw(|frame| ui::draw(frame, app))?;
        Ok(())
    }

    fn resize_inline(&mut self, app: &App, terminal_width: u16, terminal_rows: u16) -> Result<()> {
        if self.mode == TerminalMode::VirtualHistory {
            let _redirect = StdoutToTty::new(self.tty.as_raw_fd())?;
            self.terminal.autoresize()?;
            self.viewport_height = terminal_rows;
            return Ok(());
        }
        let viewport_height = inline_viewport_height(
            ui::inline_content_height(app, terminal_width),
            terminal_rows,
        );
        if viewport_height == self.viewport_height {
            return Ok(());
        }

        let current = self.terminal.current_buffer_mut().area;
        let anchor_y = current.y.min(terminal_rows.saturating_sub(1));
        let backend_tty = self
            .tty
            .try_clone()
            .context("could not clone controlling terminal for resize")?;
        let _redirect = StdoutToTty::new(self.tty.as_raw_fd())?;
        execute!(
            self.terminal.backend_mut(),
            MoveTo(current.x, anchor_y),
            Clear(ClearType::FromCursorDown)
        )?;
        self.terminal = Terminal::with_options(
            CrosstermBackend::new(backend_tty),
            TerminalOptions {
                viewport: Viewport::Inline(viewport_height),
            },
        )?;
        self.viewport_height = viewport_height;
        Ok(())
    }

    fn commit_ready_history(
        &mut self,
        app: &mut App,
        terminal_width: u16,
        terminal_rows: u16,
    ) -> Result<bool> {
        if self.mode == TerminalMode::VirtualHistory {
            return Ok(false);
        }
        if app.projection.is_none() {
            return Ok(false);
        }
        let mut changed = false;
        let include_header = !app.header_committed;
        let start = app.committed_history_count;
        let end = app.committable_history_end();
        if include_header || start < end {
            let lines = ui::committed_lines(
                app,
                start,
                end,
                include_header,
                app.header_committed || start > 0,
                terminal_width,
            );
            if !lines.is_empty() {
                self.insert_scrollback_lines(lines, terminal_width)?;
            }
            app.header_committed = true;
            app.committed_history_count = end;
            app.finish_inline_history_commit(end);
            changed = true;
        }

        if let Some(candidate) = ui::streaming_commit_candidate(app, terminal_width, terminal_rows)
        {
            self.insert_scrollback_lines(candidate.lines, terminal_width)?;
            app.record_inline_stream_commit(candidate.state);
            changed = true;
        }
        Ok(changed)
    }

    fn insert_scrollback_lines(
        &mut self,
        lines: Vec<ratatui::text::Line<'static>>,
        width: u16,
    ) -> Result<()> {
        let height = ui::committed_height(&lines, width);
        let _redirect = StdoutToTty::new(self.tty.as_raw_fd())?;
        self.terminal.insert_before(height, move |buffer| {
            Paragraph::new(Text::from(lines))
                .wrap(Wrap { trim: false })
                .render(buffer.area, buffer);
        })?;
        Ok(())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        match self.mode {
            TerminalMode::VirtualHistory => {
                let _ = execute!(
                    self.terminal.backend_mut(),
                    DisableBracketedPaste,
                    DisableMouseCapture,
                    LeaveAlternateScreen,
                    Show
                );
            }
            TerminalMode::NativeScrollback => {
                let area = self.terminal.current_buffer_mut().area;
                let _ = execute!(
                    self.terminal.backend_mut(),
                    MoveTo(area.x, area.y),
                    Clear(ClearType::FromCursorDown),
                    Show,
                    DisableBracketedPaste
                );
            }
        }
        let _ = disable_raw_mode();
    }
}

fn host_reader(
    mut reader: BufReader<std::os::unix::net::UnixStream>,
    backlog: Vec<Value>,
) -> Receiver<HostMessage> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for value in backlog {
            match serde_json::from_value::<Envelope>(value) {
                Ok(envelope) => {
                    if tx.send(HostMessage::Envelope(Box::new(envelope))).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = tx.send(HostMessage::Error(format!(
                        "invalid buffered daemon event: {error}"
                    )));
                    return;
                }
            }
        }
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line);
            if matches!(read, Ok(0)) {
                break;
            }
            let line = match read {
                Ok(_) => line.trim_end_matches(['\r', '\n']).to_owned(),
                Err(error) => {
                    let _ = tx.send(HostMessage::Error(format!(
                        "daemon connection failed: {error}"
                    )));
                    return;
                }
            };
            match line {
                line if line.trim().is_empty() => continue,
                line => match serde_json::from_str::<Envelope>(&line) {
                    Ok(envelope) => {
                        if tx.send(HostMessage::Envelope(Box::new(envelope))).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(HostMessage::Error(format!(
                            "invalid JSON from plugin host: {error}"
                        )));
                        return;
                    }
                },
            }
        }
        let _ = tx.send(HostMessage::Eof);
    });
    rx
}

fn send_request(
    output: &mut BufWriter<std::os::unix::net::UnixStream>,
    pending: &mut HashMap<String, PendingRequest>,
    counter: &mut u64,
    client_id: &str,
    agent_id: &str,
    method: &str,
    params: Value,
) -> Result<()> {
    *counter += 1;
    let id = format!("ratatui-{counter}");
    let command_id = wire::mutation(method).then(|| format!("command-{}", Uuid::new_v4()));
    serde_json::to_writer(
        &mut *output,
        &wire::command(
            id.clone(),
            client_id.to_owned(),
            command_id.clone(),
            Some(agent_id.to_owned()),
            method,
            params.clone(),
        ),
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    pending.insert(
        id,
        PendingRequest {
            method: method.to_owned(),
            params,
            command_id,
        },
    );
    Ok(())
}

fn resend_pending(
    output: &mut BufWriter<std::os::unix::net::UnixStream>,
    pending: &mut HashMap<String, PendingRequest>,
    counter: &mut u64,
    client_id: &str,
    agent_id: &str,
) -> Result<()> {
    let requests: Vec<_> = pending.drain().map(|(_, request)| request).collect();
    for request in requests {
        *counter += 1;
        let id = format!("ratatui-{counter}");
        serde_json::to_writer(
            &mut *output,
            &wire::command(
                id.clone(),
                client_id.to_owned(),
                request.command_id.clone(),
                Some(agent_id.to_owned()),
                &request.method,
                request.params.clone(),
            ),
        )?;
        output.write_all(b"\n")?;
        output.flush()?;
        pending.insert(id, request);
    }
    Ok(())
}

fn dispatch_action(
    action: Action,
    output: &mut BufWriter<std::os::unix::net::UnixStream>,
    pending: &mut HashMap<String, PendingRequest>,
    counter: &mut u64,
    client_id: &str,
    agent_id: &str,
) -> Result<bool> {
    match action {
        Action::Rpc { method, params } => {
            send_request(
                output, pending, counter, client_id, agent_id, method, params,
            )?;
            Ok(false)
        }
        Action::Exit => Ok(true),
    }
}

fn run_tui(mut attached: AttachedAgent, terminal_mode: TerminalMode) -> Result<()> {
    attached
        .connection
        .reader
        .get_mut()
        .set_read_timeout(None)?;
    let agent_id = attached
        .connection
        .agent_id
        .clone()
        .context("attached connection has no agent id")?;
    let mut client_id = attached.connection.client_id.clone();
    let mut rx = host_reader(attached.connection.reader, attached.connection.backlog);
    let mut output = attached.connection.writer;
    let mut pending = HashMap::<String, PendingRequest>::new();
    let mut request_counter = 0u64;
    let mut app = App {
        inline_mode: terminal_mode == TerminalMode::NativeScrollback,
        ..App::default()
    };
    app.load_snapshot(attached.snapshot)?;
    send_request(
        &mut output,
        &mut pending,
        &mut request_counter,
        &client_id,
        &agent_id,
        "command.list",
        json!({}),
    )?;
    let mut terminal = TerminalGuard::open(terminal_mode)?;
    let mut last_tick = Instant::now();
    let tick_rate = Duration::from_millis(80);
    let mut dirty = true;

    'ui: loop {
        if dirty {
            let terminal_size = size()?;
            terminal.commit_ready_history(&mut app, terminal_size.0, terminal_size.1)?;
            terminal.resize_inline(&app, terminal_size.0, terminal_size.1)?;
            terminal.draw(&mut app)?;
            dirty = false;
        }

        let mut disconnected = None;
        while let Ok(message) = rx.try_recv() {
            dirty = true;
            match message {
                HostMessage::Envelope(envelope) if envelope.kind == "response" => {
                    let id = envelope.id.as_deref().unwrap_or_default();
                    let method = pending
                        .remove(id)
                        .map(|request| request.method)
                        .unwrap_or_else(|| "unknown".into());
                    if envelope.ok == Some(true) {
                        app.handle_rpc_result(&method, envelope.result.unwrap_or(Value::Null));
                        if method == "frontend.exit" {
                            return Ok(());
                        }
                    } else {
                        let message = envelope
                            .error
                            .as_ref()
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Plugin RPC failed");
                        app.handle_rpc_error(message);
                    }
                }
                HostMessage::Envelope(envelope) => app.apply_envelope(&envelope),
                HostMessage::Error(error) => {
                    disconnected = Some(error);
                    break;
                }
                HostMessage::Eof if app.exiting => return Ok(()),
                HostMessage::Eof => {
                    disconnected = Some("daemon connection reached EOF".into());
                    break;
                }
            }
        }
        if let Some(reason) = disconnected {
            let cursor = app
                .projection
                .as_ref()
                .map(|projection| projection.cursor)
                .unwrap_or_default();
            let mut replacement = reconnect_tui(&agent_id, cursor)
                .with_context(|| format!("{reason}; automatic reattach failed"))?;
            replacement
                .connection
                .reader
                .get_mut()
                .set_read_timeout(None)?;
            app.load_snapshot(replacement.snapshot)?;
            client_id = replacement.connection.client_id.clone();
            rx = host_reader(
                replacement.connection.reader,
                replacement.connection.backlog,
            );
            output = replacement.connection.writer;
            resend_pending(
                &mut output,
                &mut pending,
                &mut request_counter,
                &client_id,
                &agent_id,
            )?;
            dirty = true;
            continue 'ui;
        }

        if event::poll(Duration::from_millis(25))? {
            match event::read()? {
                Event::Key(key) if !matches!(key.kind, KeyEventKind::Release) => {
                    dirty = true;
                    for action in app.handle_key(key) {
                        if dispatch_action(
                            action,
                            &mut output,
                            &mut pending,
                            &mut request_counter,
                            &client_id,
                            &agent_id,
                        )? {
                            return Ok(());
                        }
                    }
                }
                Event::Paste(text) => {
                    app.handle_paste(&text);
                    dirty = true;
                }
                Event::Mouse(mouse) => {
                    dirty |= app.handle_mouse(mouse.kind);
                }
                Event::Resize(_, _) => dirty = true,
                _ => {}
            }
        }
        if last_tick.elapsed() >= tick_rate {
            app.tick();
            last_tick = Instant::now();
            if app.busy() {
                dirty = true;
            }
        }
    }
}

fn reconnect_tui(agent_id: &str, cursor: qi_agent_tui::Cursor) -> Result<AttachedAgent> {
    let started = Instant::now();
    let mut last_error = None;
    while started.elapsed() < Duration::from_secs(15) {
        match client::attach_existing_with_cursor(agent_id, cursor, None, None) {
            Ok(attached) => return Ok(attached),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("reattach timed out")))
}

fn main() {
    if let Err(error) = entrypoint() {
        eprintln!("qi-agent failed: {error:#}");
        std::process::exit(1);
    }
}

fn entrypoint() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let repository_root = option_path(&args, "--repository-root");
    let config_path = option_path(&args, "--config");
    let preset_id = value_after(&args, "--preset");
    let repl_backend = value_after(&args, "--repl-backend");
    let terminal_mode = if args
        .iter()
        .any(|argument| argument == "--native-scrollback")
    {
        TerminalMode::NativeScrollback
    } else {
        TerminalMode::VirtualHistory
    };
    let (command, tail) = command_and_tail(&args);
    match command {
        Some("daemon") if tail.first().map(String::as_str) == Some("serve") => {
            daemon::serve(repository_root.as_deref(), config_path.as_deref())
        }
        Some("daemon") if tail.first().map(String::as_str) == Some("status") => {
            call_and_print("daemon.status", json!({}), repository_root, config_path)
        }
        Some("daemon") if tail.first().map(String::as_str) == Some("shutdown") => {
            call_and_print("daemon.shutdown", json!({}), repository_root, config_path)
        }
        Some("worker") if tail.first().map(String::as_str) == Some("serve") => {
            let descriptor = option_path(&args, "--descriptor")
                .context("worker serve requires --descriptor PATH")?;
            worker_proxy::serve(&descriptor)
        }
        Some("agents") => call_and_print("agent.list", json!({}), repository_root, config_path),
        Some("status") => call_and_print("daemon.status", json!({}), repository_root, config_path),
        Some("update") => call_and_print("daemon.update", json!({}), repository_root, config_path),
        Some("doctor") => call_and_print(
            "daemon.doctor",
            json!({"fix": tail.iter().any(|value| value == "--fix")}),
            repository_root,
            config_path,
        ),
        Some("backup") => call_and_print("daemon.backup", json!({}), repository_root, config_path),
        Some("service") => {
            let action = match tail.first().map(String::as_str).unwrap_or("print") {
                "print" => service::ServiceAction::Print,
                "install" => service::ServiceAction::Install,
                "uninstall" => service::ServiceAction::Uninstall,
                value => bail!("unknown service action: {value}"),
            };
            println!(
                "{}",
                service::manage(action, repository_root.as_deref(), config_path.as_deref())?
            );
            Ok(())
        }
        Some("shutdown") => {
            call_and_print("daemon.shutdown", json!({}), repository_root, config_path)
        }
        Some("stop") => {
            let agent_id = positional(tail, 0).context("stop requires an agent id")?;
            let mut attached = client::attach_or_create(
                Some(agent_id),
                repository_root.as_deref(),
                config_path.as_deref(),
                None,
                None,
            )?;
            let result = attached.connection.call("agent.stop", json!({}))?;
            print_json(&result)
        }
        Some("new") => {
            let selected = match preset_id {
                Some(value) => value.to_owned(),
                None => {
                    choose_preset_interactive(repository_root.as_deref(), config_path.as_deref())?
                }
            };
            run_tui(
                client::create_and_attach(
                    repository_root.as_deref(),
                    config_path.as_deref(),
                    &selected,
                    repl_backend,
                )?,
                terminal_mode,
            )
        }
        Some("run") => {
            let prompt = value_after(tail, "--detach")
                .or_else(|| positional(tail, 0))
                .context("run requires --detach PROMPT")?;
            let requested_agent = value_after(tail, "--agent");
            let mut attached = client::attach_or_create(
                requested_agent,
                repository_root.as_deref(),
                config_path.as_deref(),
                preset_id,
                repl_backend,
            )?;
            let result = attached
                .connection
                .call("prompt.submit", json!({"message": prompt}))?;
            let _ = attached.connection.call("agent.detach", json!({}));
            print_json(&json!({
                "agent_id": attached.connection.agent_id,
                "detached": true,
                "run": result
            }))
        }
        Some("repl") => {
            let agent_id = positional(tail, 0).context("repl requires an agent id")?;
            run_repl(agent_id, repository_root.as_deref(), config_path.as_deref())
        }
        Some("attach") => {
            let agent_id = positional(tail, 0).context("attach requires an agent id")?;
            run_tui(
                client::attach_or_create(
                    Some(agent_id),
                    repository_root.as_deref(),
                    config_path.as_deref(),
                    None,
                    None,
                )?,
                terminal_mode,
            )
        }
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            Ok(())
        }
        Some(value) if !value.starts_with('-') => bail!("unknown qi-agent command: {value}"),
        Some(value) => bail!("unknown qi-agent option: {value}"),
        _ => run_tui(
            client::attach_or_create(
                None,
                repository_root.as_deref(),
                config_path.as_deref(),
                preset_id,
                repl_backend,
            )?,
            terminal_mode,
        ),
    }
}

fn command_and_tail(args: &[String]) -> (Option<&str>, &[String]) {
    let mut index = 0;
    while index < args.len() {
        if matches!(
            args[index].as_str(),
            "--config" | "--preset" | "--repository-root" | "--repl-backend"
        ) {
            index += 2;
            continue;
        }
        if args[index] == "--native-scrollback" {
            index += 1;
            continue;
        }
        if matches!(args[index].as_str(), "--help" | "-h") {
            return (Some(args[index].as_str()), &args[index + 1..]);
        }
        if args[index].starts_with('-') {
            return (Some(args[index].as_str()), &args[index + 1..]);
        }
        return (Some(args[index].as_str()), &args[index + 1..]);
    }
    (None, &[])
}

fn choose_preset_interactive(
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<String> {
    let presets = client::list_presets(repository_root, config_path)?;
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .context("qi-agent new requires a terminal; pass --preset ID for automation")?;
    writeln!(tty, "选择新会话的 Agent 模式：")?;
    for (index, preset) in presets.iter().enumerate() {
        let state = if preset.broken { " [不可用]" } else { "" };
        writeln!(
            tty,
            "  {}. {} ({}){}",
            index + 1,
            preset.name,
            preset.id,
            state,
        )?;
        if let Some(description) = preset.description.as_deref() {
            writeln!(tty, "     {description}")?;
        }
    }
    write!(tty, "请选择编号 [默认 standard]: ")?;
    tty.flush()?;
    let mut input = String::new();
    BufReader::new(tty.try_clone()?).read_line(&mut input)?;
    let choices = presets
        .iter()
        .map(|preset| (preset.id.clone(), preset.broken))
        .collect::<Vec<_>>();
    select_preset_id(&choices, &input)
}

fn select_preset_id(presets: &[(String, bool)], input: &str) -> Result<String> {
    if input.trim().is_empty() {
        return presets
            .iter()
            .find(|(id, broken)| id == "standard" && !broken)
            .or_else(|| presets.iter().find(|(_, broken)| !broken))
            .map(|(id, _)| id.clone())
            .context("no usable presets are available");
    }
    let index = input
        .trim()
        .parse::<usize>()
        .context("preset selection must be a number")?;
    let (id, broken) = presets
        .get(index.saturating_sub(1))
        .with_context(|| format!("preset selection is out of range: {index}"))?;
    if *broken {
        bail!("the selected preset is broken")
    }
    Ok(id.clone())
}

const USAGE: &str = "Daemon-backed Clojure agent runtime

  qi-agent                              attach/create and open the Rust TUI
  qi-agent new [--preset ID]            choose a mode and create a distinct Agent/Session
  qi-agent agents                       list saved and resident agents
  qi-agent attach AGENT_ID              attach the TUI to an agent
  qi-agent run --detach PROMPT          submit background work and return
  qi-agent repl AGENT_ID                open the agent's Clojure REPL
  qi-agent status                       show daemon and worker state
  qi-agent update                       recover missing workers and refresh leases
  qi-agent doctor                       run non-destructive diagnostics
  qi-agent doctor --fix                 purge only provably expired leases
  qi-agent backup                       create a consistent SQLite snapshot
  qi-agent service print|install|uninstall
                                   manage the per-user OS daemon service
  qi-agent stop AGENT_ID                explicitly stop one root agent tree
  qi-agent shutdown                     stop all workers and the daemon
  qi-agent daemon serve                 run the supervisor in the foreground

Options:
  --config PATH                    trusted daemon default profile (default: agent.edn)
  --preset ID                      registered Preset for a newly created Agent
  --native-scrollback              use terminal scrollback instead of virtual history
  --repl-backend BACKEND           babashka (default) or jvm-clojure
  --repository-root PATH           qi-agent runtime source root";

fn call_and_print(
    method: &str,
    parameters: Value,
    repository_root: Option<PathBuf>,
    config_path: Option<PathBuf>,
) -> Result<()> {
    let mut connection =
        client::connect_or_launch(repository_root.as_deref(), config_path.as_deref())?;
    let result = connection.call(method, parameters)?;
    print_json(&result)
}

fn run_repl(
    agent_id: &str,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<()> {
    let mut attached =
        client::attach_or_create(Some(agent_id), repository_root, config_path, None, None)?;
    println!("Clojure REPL for {agent_id}. Ctrl-D exits without stopping the agent.");
    let stdin = io::stdin();
    loop {
        print!("{agent_id}=> ");
        io::stdout().flush()?;
        let mut code = String::new();
        if stdin.read_line(&mut code)? == 0 {
            break;
        }
        if code.trim().is_empty() {
            continue;
        }
        match attached
            .connection
            .call("repl.eval", json!({"code": code, "replay_safe": false}))
        {
            Ok(value) => print_json(&value)?,
            Err(error) => eprintln!("{error:#}"),
        }
    }
    let _ = attached.connection.call("agent.detach", json!({}));
    Ok(())
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn option_path(args: &[String], flag: &str) -> Option<PathBuf> {
    value_after(args, flag).map(PathBuf::from)
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .rposition(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn positional(args: &[String], index: usize) -> Option<&str> {
    let mut skip_next = false;
    args.iter()
        .filter(|argument| {
            if skip_next {
                skip_next = false;
                return false;
            }
            if matches!(
                argument.as_str(),
                "--config" | "--preset" | "--repository-root" | "--repl-backend" | "--agent"
            ) {
                skip_next = true;
                return false;
            }
            !argument.starts_with('-')
        })
        .nth(index)
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn top_level_help_is_a_command_instead_of_starting_the_tui() {
        let values = args(&["--repository-root", "/tmp/qi-agent", "--help"]);
        let (command, tail) = command_and_tail(&values);
        assert_eq!(command, Some("--help"));
        assert!(tail.is_empty());
    }

    #[test]
    fn unknown_top_level_options_are_not_silently_ignored() {
        let values = args(&["--unknown"]);
        let (command, tail) = command_and_tail(&values);
        assert_eq!(command, Some("--unknown"));
        assert!(tail.is_empty());
    }

    #[test]
    fn native_scrollback_is_a_global_tui_option() {
        let values = args(&["--native-scrollback", "attach", "agent-1"]);
        let (command, tail) = command_and_tail(&values);
        assert_eq!(command, Some("attach"));
        assert_eq!(positional(tail, 0), Some("agent-1"));

        let values = args(&["attach", "--native-scrollback", "agent-2"]);
        let (command, tail) = command_and_tail(&values);
        assert_eq!(command, Some("attach"));
        assert_eq!(positional(tail, 0), Some("agent-2"));
    }

    #[test]
    fn the_last_repeated_option_overrides_an_installed_launcher_default() {
        let values = args(&[
            "--config",
            "/installed/agent.edn",
            "--config",
            "/workspace/jvm-clojure.edn",
        ]);
        assert_eq!(
            value_after(&values, "--config"),
            Some("/workspace/jvm-clojure.edn")
        );
    }

    #[test]
    fn preset_is_a_global_agent_creation_option() {
        let values = args(&[
            "--repository-root",
            "/installed/qi-agent",
            "--config",
            "/installed/qi-agent/agent.edn",
            "--preset",
            "standard",
            "run",
            "--detach",
            "hello",
        ]);
        let (command, tail) = command_and_tail(&values);
        assert_eq!(command, Some("run"));
        assert_eq!(value_after(&values, "--preset"), Some("standard"));
        assert_eq!(value_after(tail, "--detach"), Some("hello"));
    }

    #[test]
    fn new_session_preset_selection_defaults_to_standard_and_rejects_broken_modes() {
        let presets = vec![
            ("standard".to_owned(), false),
            ("creator".to_owned(), false),
            ("broken".to_owned(), true),
        ];
        assert_eq!(select_preset_id(&presets, "").unwrap(), "standard");
        assert_eq!(select_preset_id(&presets, "2").unwrap(), "creator");
        assert!(select_preset_id(&presets, "3").is_err());
        assert!(select_preset_id(&presets, "9").is_err());
    }

    #[test]
    fn inline_viewport_height_tracks_content_with_safe_terminal_bounds() {
        assert_eq!(inline_viewport_height(4, 0), 4);
        assert_eq!(inline_viewport_height(4, 44), 4);
        assert_eq!(inline_viewport_height(18, 44), 18);
        assert_eq!(inline_viewport_height(30, 44), 30);
        assert_eq!(inline_viewport_height(12, 8), 8);
        assert_eq!(inline_viewport_height(40, 80), 40);
        assert_eq!(inline_viewport_height(100, 80), 80);
    }
}
