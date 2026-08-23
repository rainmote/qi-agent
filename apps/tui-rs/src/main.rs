use anyhow::{Context, Result, bail};
use bb_agent_tui::{Action, App, Envelope, ui};
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind},
    execute,
    terminal::{Clear, ClearType, disable_raw_mode, enable_raw_mode},
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
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Write},
    os::fd::{AsRawFd, RawFd},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const INLINE_VIEWPORT_HEIGHT: u16 = 18;

enum HostMessage {
    Envelope(Box<Envelope>),
    Error(String),
    Eof,
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<File>>,
    tty_fd: RawFd,
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
    fn open() -> Result<Self> {
        let mut tty = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .context("could not open controlling terminal /dev/tty")?;
        let mut cleanup_tty = tty
            .try_clone()
            .context("could not clone controlling terminal")?;
        let tty_fd = tty.as_raw_fd();
        enable_raw_mode().context("could not enable terminal raw mode")?;
        if let Err(error) = execute!(tty, EnableBracketedPaste, Hide) {
            let _ = execute!(cleanup_tty, Show, DisableBracketedPaste);
            let _ = disable_raw_mode();
            return Err(error).context("could not initialize inline terminal UI");
        }
        let terminal = match StdoutToTty::new(tty_fd).and_then(|_redirect| {
            Terminal::with_options(
                CrosstermBackend::new(tty),
                TerminalOptions {
                    viewport: Viewport::Inline(INLINE_VIEWPORT_HEIGHT),
                },
            )
        }) {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = execute!(cleanup_tty, Show, DisableBracketedPaste);
                let _ = disable_raw_mode();
                return Err(error).context("could not create inline terminal viewport");
            }
        };
        Ok(Self { terminal, tty_fd })
    }

    fn draw(&mut self, app: &App) -> Result<()> {
        let _redirect = StdoutToTty::new(self.tty_fd)?;
        self.terminal.draw(|frame| ui::draw(frame, app))?;
        Ok(())
    }

    fn commit_ready_history(&mut self, app: &mut App) -> Result<bool> {
        if app.projection.is_none() {
            return Ok(false);
        }
        let include_header = !app.header_committed;
        let start = app.committed_history_count;
        let end = app.committable_history_end();
        if !include_header && start >= end {
            return Ok(false);
        }
        let width = self.terminal.size()?.width;
        let lines = ui::committed_lines(
            app,
            start,
            end,
            include_header,
            app.header_committed || start > 0,
            width,
        );
        if lines.is_empty() {
            return Ok(false);
        }
        let height = ui::committed_height(&lines, width);
        let _redirect = StdoutToTty::new(self.tty_fd)?;
        self.terminal.insert_before(height, move |buffer| {
            Paragraph::new(Text::from(lines))
                .wrap(Wrap { trim: false })
                .render(buffer.area, buffer);
        })?;
        app.header_committed = true;
        app.committed_history_count = end;
        Ok(true)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let area = self.terminal.current_buffer_mut().area;
        let _ = execute!(
            self.terminal.backend_mut(),
            MoveTo(area.x, area.y),
            Clear(ClearType::FromCursorDown),
            Show,
            DisableBracketedPaste
        );
        let _ = disable_raw_mode();
    }
}

fn host_reader() -> Receiver<HostMessage> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in BufReader::new(stdin.lock()).lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => match serde_json::from_str::<Envelope>(&line) {
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
                Err(error) => {
                    let _ = tx.send(HostMessage::Error(format!(
                        "plugin host input failed: {error}"
                    )));
                    return;
                }
            }
        }
        let _ = tx.send(HostMessage::Eof);
    });
    rx
}

fn send_request(
    output: &mut BufWriter<io::Stdout>,
    pending: &mut HashMap<String, String>,
    counter: &mut u64,
    method: &str,
    params: Value,
) -> Result<()> {
    *counter += 1;
    let id = format!("ratatui-{counter}");
    serde_json::to_writer(
        &mut *output,
        &json!({
            "type":"request", "id":id, "method":method, "params":params
        }),
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    pending.insert(id, method.to_owned());
    Ok(())
}

fn dispatch_action(
    action: Action,
    output: &mut BufWriter<io::Stdout>,
    pending: &mut HashMap<String, String>,
    counter: &mut u64,
) -> Result<bool> {
    match action {
        Action::Rpc { method, params } => {
            send_request(output, pending, counter, method, params)?;
            Ok(false)
        }
        Action::Exit => Ok(true),
    }
}

fn run() -> Result<()> {
    let rx = host_reader();
    let mut output = BufWriter::new(io::stdout());
    let mut pending = HashMap::<String, String>::new();
    let mut request_counter = 0u64;
    let mut ready = false;
    let mut app = App {
        inline_mode: true,
        ..App::default()
    };
    let mut terminal = TerminalGuard::open()?;
    let mut last_tick = Instant::now();
    let tick_rate = Duration::from_millis(80);
    let mut dirty = true;

    loop {
        if dirty {
            terminal.commit_ready_history(&mut app)?;
            terminal.draw(&app)?;
            dirty = false;
        }

        while let Ok(message) = rx.try_recv() {
            dirty = true;
            match message {
                HostMessage::Envelope(envelope) if envelope.kind == "ready" => {
                    if !ready {
                        ready = true;
                        send_request(
                            &mut output,
                            &mut pending,
                            &mut request_counter,
                            "session.snapshot",
                            json!({}),
                        )?;
                        send_request(
                            &mut output,
                            &mut pending,
                            &mut request_counter,
                            "command.list",
                            json!({}),
                        )?;
                    }
                }
                HostMessage::Envelope(envelope) if envelope.kind == "response" => {
                    let id = envelope.id.as_deref().unwrap_or_default();
                    let method = pending.remove(id).unwrap_or_else(|| "unknown".into());
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
                HostMessage::Error(error) => bail!(error),
                HostMessage::Eof if app.exiting => return Ok(()),
                HostMessage::Eof => bail!("plugin host input reached EOF"),
            }
        }

        if event::poll(Duration::from_millis(25))? {
            match event::read()? {
                Event::Key(key) if !matches!(key.kind, KeyEventKind::Release) => {
                    dirty = true;
                    for action in app.handle_key(key) {
                        if dispatch_action(action, &mut output, &mut pending, &mut request_counter)?
                        {
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
                Event::Resize(_, _) => {
                    dirty = true;
                }
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

fn main() {
    if let Err(error) = run() {
        eprintln!("Ratatui frontend failed: {error:#}");
        std::process::exit(1);
    }
}
