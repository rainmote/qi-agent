//! Native-only supervisor. No operation in this crate is exposed as renderer IPC.
pub mod acceptance;
pub mod browser;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::OpenOptionsExt, fs::PermissionsExt, net::UnixStream},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
pub struct Ready {
    kind: String,
    pub port: u16,
    token: String,
}

impl Ready {
    pub fn parse(line: &str) -> Result<Self> {
        ensure!(line.len() <= 4096, "oversized Host startup frame");
        let frame: Value = serde_json::from_str(line)?;
        if frame["kind"] == "failed" {
            let reason = frame["reason"]
                .as_str()
                .filter(|s| s.len() <= 64 && s.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'))
                .unwrap_or("unknown");
            anyhow::bail!("desktop Host startup failed: {reason}");
        }
        let ready: Self = serde_json::from_str(line)?;
        ensure!(
            ready.kind == "ready" && ready.port >= 1024,
            "invalid Host startup address"
        );
        ensure!(
            ready.token.len() >= 24
                && ready.token.len() <= 128
                && ready
                    .token
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
            "invalid Host startup token"
        );
        Ok(ready)
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn bootstrap_url(&self) -> Result<Url> {
        let mut url = Url::parse(&self.origin())?;
        url.query_pairs_mut().append_pair("token", &self.token);
        Ok(url)
    }
    pub fn health(&self) -> Result<()> {
        // Never inherit a proxy or follow a redirect with the private token.
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let response = client
            .get(format!("{}/health/ready", self.origin()))
            .send()?;
        ensure!(response.status().is_success(), "Host readiness failed");
        let body: Value = response.json()?;
        ensure!(body["ok"] == true, "Host resources are not ready");
        // The health endpoint only checks resources. Authentication is checked
        // separately; neither check claims that an agent/model E2E has passed.
        let authenticated = client
            .get(format!("{}/api/bootstrap", self.origin()))
            .bearer_auth(&self.token)
            .send()?;
        ensure!(
            authenticated.status().is_success(),
            "Host authentication failed"
        );
        Ok(())
    }
}

/// Only user-confirmed external web/mail/telephone links may leave the app.
pub fn external_link(raw: &str) -> Result<Url> {
    ensure!(
        raw.len() <= 4096 && !raw.chars().any(char::is_control),
        "invalid external link"
    );
    let url = Url::parse(raw)?;
    ensure!(
        matches!(url.scheme(), "https" | "http" | "mailto" | "tel"),
        "unsupported external scheme"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "credentials in external URL"
    );
    ensure!(
        !url.query_pairs().any(|(key, _)| matches!(
            key.to_ascii_lowercase().as_str(),
            "token" | "access_token" | "refresh_token" | "api_key" | "authorization"
        )),
        "private token URL"
    );
    if matches!(url.scheme(), "http" | "https") {
        ensure!(url.host_str().is_some(), "missing external host");
        ensure!(
            !matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            ),
            "local Host links stay in the app"
        );
    }
    Ok(url)
}

pub fn private_directory(path: &Path) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "private path is not a real directory"
        );
    }
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn private_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("missing private parent")?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".desktop-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn lock_installation(state: &Path) -> Result<File> {
    private_directory(state)?;
    let path = state.join("desktop.lock");
    if let Ok(meta) = fs::symlink_metadata(&path) {
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "invalid desktop lease"
        );
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    file.try_lock_exclusive()
        .context("another desktop instance owns this state")?;
    Ok(file)
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    architecture: String,
    source_sha: String,
    files: BTreeMap<String, String>,
}

pub fn verify_payload(root: &Path) -> Result<()> {
    let manifest: Manifest =
        serde_json::from_reader(File::open(root.join("runtime-manifest.json"))?)?;
    ensure!(
        manifest.schema == 1 && manifest.architecture == std::env::consts::ARCH,
        "incompatible desktop runtime"
    );
    ensure!(
        manifest.source_sha.len() == 40
            && manifest.source_sha.bytes().all(|b| b.is_ascii_hexdigit()),
        "missing source revision"
    );
    for required in [
        "bin/node",
        "bin/bb",
        "bin/qi-agent",
        "apps/desktop/host.mjs",
        "apps/web/dist/index.html",
        "agent.edn",
        "bb.edn",
    ] {
        ensure!(
            manifest.files.contains_key(required),
            "missing bundled runtime entry: {required}"
        );
    }
    for (relative, expected) in &manifest.files {
        ensure!(
            Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
            "unsafe runtime manifest path"
        );
        let path = root.join(relative);
        let meta = fs::symlink_metadata(&path)?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "invalid runtime file"
        );
        ensure!(
            path.canonicalize()?.starts_with(root.canonicalize()?),
            "runtime file escaped its bundle"
        );
        let mut file = File::open(path)?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        ensure!(
            format!("{:x}", digest.finalize()) == *expected,
            "bundled runtime checksum mismatch: {relative}"
        );
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
struct Owner {
    run_id: String,
    runtime: PathBuf,
}

fn check_receipt(owner: &Owner) -> Result<()> {
    let receipt: Value =
        serde_json::from_reader(File::open(owner.runtime.join("desktop-shutdown.json"))?)?;
    ensure!(
        receipt["run_id"] == owner.run_id && receipt["ok"] == true,
        "previous desktop cleanup is unknown; review its retained worker state before another start"
    );
    Ok(())
}

fn shutdown_response(reader: &mut impl BufRead, id: &str) -> Result<()> {
    for _ in 0..8 {
        let mut line = Vec::new();
        (&mut *reader).take(16385).read_until(b'\n', &mut line)?;
        ensure!(
            !line.is_empty() && line.len() <= 16384 && line.ends_with(b"\n"),
            "invalid daemon shutdown response frame"
        );
        let frame: Value = serde_json::from_slice(&line)?;
        if frame["type"] == "response" && frame["id"] == id {
            ensure!(
                frame["version"] == 1 && frame["ok"] == true,
                "daemon rejected shutdown; result unconfirmed"
            );
            return Ok(());
        }
    }
    anyhow::bail!("matching daemon shutdown response missing")
}

fn recover_clean_owner(state: &Path) -> Result<()> {
    let path = state.join("desktop-owner.json");
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(&path)?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 4096,
        "invalid previous desktop owner"
    );
    let owner: Owner = serde_json::from_reader(File::open(&path)?)?;
    ensure!(
        Uuid::parse_str(&owner.run_id).is_ok(),
        "invalid previous generation"
    );
    ensure!(
        owner.runtime.parent() == Some(Path::new("/tmp"))
            && owner
                .runtime
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("qi-d-")),
        "invalid owned runtime path"
    );
    let directory = fs::symlink_metadata(&owner.runtime)?;
    ensure!(
        directory.is_dir() && !directory.file_type().is_symlink(),
        "invalid previous runtime directory"
    );
    check_receipt(&owner).context("previous desktop session needs cleanup reconciliation")?;
    // A true receipt and the persistent daemon lease are both necessary.
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(state.join("web/daemon-state/desktop-daemon.lock"))?;
    lease
        .try_lock_exclusive()
        .context("the previous daemon is still stopping")?;
    fs::remove_file(path)?;
    // Do not recursively delete a path read from a persistent file. Old private
    // directories are retained for diagnosis; only our live TempDir is removed.
    Ok(())
}

pub struct Runtime {
    host: Option<Child>,
    daemon: Option<Child>,
    pub ready: Option<Ready>,
    state: PathBuf,
    owner: Owner,
    temporary: Option<tempfile::TempDir>,
    shutdown_sent: bool,
    shutdown_id: String,
    daemon_started: bool,
}

impl Runtime {
    fn prepare(payload: &Path, state: &Path) -> Result<Self> {
        verify_payload(payload)?;
        private_directory(state)?;
        private_directory(&state.join("web/daemon-state"))?;
        recover_clean_owner(state)?;
        let temporary = tempfile::Builder::new()
            .prefix("qi-d-")
            .tempdir_in("/tmp")?;
        let owner = Owner {
            run_id: Uuid::new_v4().to_string(),
            runtime: temporary.path().to_path_buf(),
        };
        private_json(&state.join("desktop-owner.json"), &owner)?;
        Ok(Self {
            host: None,
            daemon: None,
            ready: None,
            state: state.to_path_buf(),
            owner,
            temporary: Some(temporary),
            shutdown_sent: false,
            shutdown_id: Uuid::new_v4().to_string(),
            daemon_started: false,
        })
    }

    fn command(&self, executable: &Path, payload: &Path) -> Result<Command> {
        let mut command = Command::new(executable);
        // Do not import shell init files, Node options, DYLD injection, proxies,
        // model keys or arbitrary runtime overrides into bundled executables.
        command
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                    payload.join("bin").display()
                ),
            )
            .env(
                "HOME",
                std::env::var_os("HOME").context("HOME unavailable")?,
            )
            .env("TMPDIR", "/tmp")
            .env("LANG", "en_US.UTF-8")
            .env("QI_AGENT_HOME", self.state.join("qi-home"))
            .env(
                "QI_AGENT_PRESET_USER_ROOT",
                self.state.join("qi-home/presets"),
            )
            .env("QI_AGENT_STATE_DIR", self.state.join("web/daemon-state"))
            .env("QI_AGENT_RUNTIME_DIR", &self.owner.runtime)
            .env("QI_AGENT_REPOSITORY_ROOT", payload)
            .env(
                "QI_AGENT_PROVIDER_SETTINGS_FILE",
                self.state.join("web/providers.json"),
            )
            .env(
                "QI_AGENT_ATTACHMENT_DIR",
                self.state.join("web/attachments"),
            )
            .env("QI_AGENT_BIN", payload.join("bin/qi-agent"))
            .env("QI_AGENT_DESKTOP_STATE_DIR", &self.state)
            .current_dir(payload)
            .stderr(Stdio::null());
        // Preserve an explicitly supplied auth-home override, including the
        // isolated acceptance runner's empty state. Never copy credentials.
        if let Some(home) = std::env::var_os("CODEX_HOME") {
            command.env("CODEX_HOME", home);
        }
        Ok(command)
    }

    fn launch(&mut self, payload: &Path) -> Result<()> {
        self.daemon = Some(
            self.command(&payload.join("bin/qi-agent"), payload)?
                .args(["daemon", "serve", "--repository-root"])
                .arg(payload)
                .arg("--config")
                .arg(payload.join("agent.edn"))
                .env(
                    "QI_AGENT_DESKTOP_PARENT_PID",
                    std::process::id().to_string(),
                )
                .env("QI_AGENT_DESKTOP_RUN_ID", &self.owner.run_id)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()?,
        );
        self.daemon_started = true;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !self.owner.runtime.join("daemon.sock").exists() {
            ensure!(
                self.daemon.as_mut().unwrap().try_wait()?.is_none(),
                "bundled daemon exited before readiness"
            );
            ensure!(
                Instant::now() < deadline,
                "bundled daemon startup timed out"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let mut host = self
            .command(&payload.join("bin/node"), payload)?
            .arg(payload.join("apps/desktop/host.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let stdout = host
            .stdout
            .take()
            .context("Host private startup pipe missing")?;
        self.host = Some(host);
        let (send, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut line = String::new();
            let mut reader = BufReader::new(stdout);
            let result = reader
                .by_ref()
                .take(4097)
                .read_line(&mut line)
                .map_err(anyhow::Error::from)
                .and_then(|_| Ready::parse(&line));
            let _ = send.send(result);
            // Never retain or print the token-bearing startup frame.
            drop(line);
            let mut discard = [0; 4096];
            while reader.read(&mut discard).is_ok_and(|n| n > 0) {}
        });
        let ready = receive
            .recv_timeout(Duration::from_secs(30))
            .context("Host startup timed out")??;
        ready.health()?;
        self.ready = Some(ready);
        Ok(())
    }

    pub fn alive(&mut self) -> bool {
        self.host
            .as_mut()
            .is_some_and(|c| c.try_wait().is_ok_and(|s| s.is_none()))
            && self
                .daemon
                .as_mut()
                .is_some_and(|c| c.try_wait().is_ok_and(|s| s.is_none()))
    }

    fn request_shutdown(&mut self) -> Result<()> {
        if self.shutdown_sent {
            return Ok(());
        }
        let mut stream = UnixStream::connect(self.owner.runtime.join("daemon.sock"))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let frame = json!({"version":1,"type":"command","request_id":self.shutdown_id,
            "client_id":format!("desktop-{}", self.owner.run_id),"journal_id":format!("desktop-{}", self.owner.run_id),
            "command_id":self.shutdown_id,"agent_id":null,"method":"daemon.shutdown","params":{}});
        // Record before writing: partial writes have an unknown outcome and
        // must not be issued again with a new command ID.
        self.shutdown_sent = true;
        stream.write_all(format!("{frame}\n").as_bytes())?;
        // Keep the connection alive until the matching response is read. The
        // daemon schedules shutdown only after successfully writing that reply.
        shutdown_response(&mut BufReader::new(stream), &self.shutdown_id)?;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        self.ready = None;
        if let Some(host) = &mut self.host {
            if let Some(mut input) = host.stdin.take() {
                let _ = input.write_all(b"shutdown\n");
            }
        }
        if self.daemon.is_some() {
            let _ = self.request_shutdown();
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let done = match self.daemon.as_mut() {
                Some(child) => child.try_wait()?.is_some(),
                None => true,
            };
            if done {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "daemon cleanup not confirmed; desktop restart blocked"
            );
            thread::sleep(Duration::from_millis(50));
        }
        self.daemon = None;
        if let Some(host) = &mut self.host {
            let deadline = Instant::now() + Duration::from_secs(5);
            while host.try_wait()?.is_none() {
                ensure!(
                    Instant::now() < deadline,
                    "Host exit not confirmed; ownership retained"
                );
                thread::sleep(Duration::from_millis(50));
            }
        }
        self.host = None;
        if self.daemon_started {
            check_receipt(&self.owner)
                .context("worker cleanup UNKNOWN; retained ownership state blocks a new run")?;
        }
        fs::remove_file(self.state.join("desktop-owner.json"))?;
        self.temporary.take();
        Ok(())
    }

    fn retain_directory(&mut self) {
        if let Some(temp) = self.temporary.take() {
            let _ = temp.keep();
        }
    }
}

#[derive(Default)]
pub struct Supervisor {
    runtime: Option<Runtime>,
}

impl Supervisor {
    pub fn launch(&mut self, payload: &Path, state: &Path) -> Result<Ready> {
        self.stop()?;
        self.runtime = Some(Runtime::prepare(payload, state)?);
        let result = self.runtime.as_mut().unwrap().launch(payload);
        if let Err(error) = result {
            let cleanup = self.stop();
            return Err(error.context(if cleanup.is_ok() {
                "startup stopped; cleanup confirmed"
            } else {
                "startup stopped; cleanup UNKNOWN; retained supervisor blocks another run"
            }));
        }
        self.runtime
            .as_ref()
            .unwrap()
            .ready
            .clone()
            .context("missing ready state")
    }
    pub fn stop(&mut self) -> Result<()> {
        if let Some(runtime) = &mut self.runtime {
            runtime.stop()?;
        }
        self.runtime = None;
        Ok(())
    }
    pub fn has_runtime(&self) -> bool {
        self.runtime.is_some()
    }
    pub fn alive(&mut self) -> bool {
        self.runtime.as_mut().is_some_and(Runtime::alive)
    }
    pub fn ready(&self) -> Option<Ready> {
        self.runtime
            .as_ref()
            .and_then(|runtime| runtime.ready.clone())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Do not kill a daemon with setsid workers or delete uncertain identity
        // records. Its parent monitor and retained state are the crash backstop.
        if self.temporary.is_some() {
            self.retain_directory();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_cannot_choose_a_remote_origin_or_smuggle_a_token_url() {
        assert!(
            Ready::parse(
                r#"{"kind":"ready","port":43127,"token":"abcdefghijklmnopqrstuvwxyz_012345"}"#
            )
            .is_ok()
        );
        for bad in [
            r#"{"kind":"ready","port":80,"token":"abcdefghijklmnopqrstuvwxyz"}"#,
            r#"{"kind":"ready","port":43127,"token":"https://remote.invalid/?token=x"}"#,
        ] {
            assert!(Ready::parse(bad).is_err());
        }
    }
    #[test]
    fn external_links_reject_native_schemes_credentials_and_private_bootstrap() {
        for good in [
            "https://tauri.app/docs",
            "mailto:help@example.invalid",
            "tel:+123456",
        ] {
            assert!(external_link(good).is_ok());
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://u:p@example.invalid/",
            "http://127.0.0.1:43127/",
            "https://example.invalid/?token=secret",
            "https://example.invalid/\n",
        ] {
            assert!(external_link(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn uncertain_previous_owner_blocks_a_new_launch_without_deleting_it() {
        let state = tempfile::tempdir().unwrap();
        let owner = Owner {
            run_id: Uuid::new_v4().to_string(),
            runtime: PathBuf::from("/tmp/qi-d-not-executed"),
        };
        private_json(&state.path().join("desktop-owner.json"), &owner).unwrap();
        assert!(recover_clean_owner(state.path()).is_err());
        assert!(state.path().join("desktop-owner.json").exists());
    }
    #[test]
    fn shutdown_requires_a_matching_successful_bounded_reply() {
        let mut valid = std::io::Cursor::new(b"{\"type\":\"hello\"}\n{\"version\":1,\"type\":\"response\",\"id\":\"own\",\"ok\":true}\n");
        assert!(shutdown_response(&mut valid, "own").is_ok());
        for invalid in [
            b"{\"version\":1,\"type\":\"response\",\"id\":\"old\",\"ok\":true}\n".to_vec(),
            b"{\"version\":1,\"type\":\"response\",\"id\":\"own\",\"ok\":false}\n".to_vec(),
            vec![b' '; 16385],
        ] {
            assert!(shutdown_response(&mut std::io::Cursor::new(invalid), "own").is_err());
        }
    }
    #[test]
    fn missing_cleanup_receipt_retains_identity_even_after_children_exited() {
        let state = tempfile::tempdir().unwrap();
        let temporary = tempfile::Builder::new()
            .prefix("qi-d-unit-")
            .tempdir_in("/tmp")
            .unwrap();
        let directory = temporary.path().to_path_buf();
        let owner = Owner {
            run_id: Uuid::new_v4().to_string(),
            runtime: directory.clone(),
        };
        private_json(&state.path().join("desktop-owner.json"), &owner).unwrap();
        let mut runtime = Runtime {
            host: None,
            daemon: None,
            ready: None,
            state: state.path().to_path_buf(),
            owner,
            temporary: Some(temporary),
            shutdown_sent: true,
            shutdown_id: Uuid::new_v4().to_string(),
            daemon_started: true,
        };
        assert!(runtime.stop().is_err());
        drop(runtime);
        assert!(directory.exists());
        assert!(state.path().join("desktop-owner.json").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
