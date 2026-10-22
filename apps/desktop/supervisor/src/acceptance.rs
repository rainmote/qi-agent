//! A bounded cold-start observation mode. It grants no tool, project, or OS permission.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema: u32,
    pub run_id: String,
    pub source_sha: String,
    pub controller_sha256: String,
    pub fixture_id: String,
    pub phase: u8,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AuthProbe {
    schema: u8,
    complete: bool,
    document_html: bool,
    token_free_url: bool,
    app_shell_visible: bool,
    draft_view_visible: bool,
    composer_visible_enabled: bool,
    workspace_bound: bool,
    bootstrap_status: u16,
    bootstrap_ok: bool,
    bootstrap_shape: bool,
    no_sessions: bool,
    probe_error: bool,
}

impl AuthProbe {
    fn passed(&self) -> bool {
        self.schema == 1
            && self.complete
            && self.document_html
            && self.token_free_url
            && self.app_shell_visible
            && self.draft_view_visible
            && self.composer_visible_enabled
            && self.workspace_bound
            && self.bootstrap_status == 200
            && self.bootstrap_ok
            && self.bootstrap_shape
            && self.no_sessions
            && !self.probe_error
    }
}

pub struct Acceptance {
    pub root: PathBuf,
    pub plan: Plan,
    started: Instant,
    observations: Mutex<BTreeSet<String>>,
    auth_probe: Mutex<Option<AuthProbe>>,
    pub finishing: AtomicBool,
    failed: AtomicBool,
}

impl Acceptance {
    pub fn load(root: &Path, run_id: &str) -> Result<Self> {
        Self::load_with_homes(
            root,
            run_id,
            std::env::var_os("HOME").as_deref(),
            std::env::var_os("CODEX_HOME").as_deref(),
        )
    }
    fn load_with_homes(
        root: &Path,
        run_id: &str,
        home_env: Option<&std::ffi::OsStr>,
        auth_env: Option<&std::ffi::OsStr>,
    ) -> Result<Self> {
        ensure!(
            root.is_absolute() && root.canonicalize()? == root,
            "acceptance root must be canonical"
        );
        let meta = fs::symlink_metadata(root)?;
        ensure!(
            meta.is_dir()
                && !meta.file_type().is_symlink()
                && meta.permissions().mode() & 0o077 == 0,
            "acceptance root must be private"
        );
        let plan_path = root.join("plan.json");
        let plan_meta = fs::symlink_metadata(&plan_path)?;
        ensure!(
            plan_meta.is_file()
                && !plan_meta.file_type().is_symlink()
                && plan_meta.len() <= 2048
                && plan_meta.permissions().mode() & 0o077 == 0
                && plan_meta.uid() == meta.uid(),
            "acceptance plan must be a private owned file"
        );
        let plan: Plan = serde_json::from_slice(&fs::read(plan_path)?)?;
        ensure!(
            plan.schema == 2
                && plan.run_id == run_id
                && Uuid::parse_str(run_id).is_ok()
                && Uuid::parse_str(&plan.fixture_id).is_ok()
                && matches!(plan.phase, 1 | 2),
            "acceptance run mismatch"
        );
        ensure!(
            root.file_name().and_then(|value| value.to_str())
                == Some(format!("phase-{}", plan.phase).as_str()),
            "acceptance phase path mismatch"
        );
        let fixture = root.parent().context("acceptance fixture missing")?;
        let fixture_meta = fs::symlink_metadata(fixture)?;
        ensure!(
            fixture.canonicalize()? == fixture
                && fixture_meta.is_dir()
                && !fixture_meta.file_type().is_symlink()
                && fixture_meta.permissions().mode() & 0o077 == 0
                && fixture_meta.uid() == meta.uid(),
            "acceptance fixture must be private and owned"
        );
        for (value, length) in [(&plan.source_sha, 40), (&plan.controller_sha256, 64)] {
            ensure!(
                value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit()),
                "acceptance provenance missing"
            );
        }
        ensure!(
            !root.join("result.json").exists() && !root.join("events.jsonl").exists(),
            "acceptance run already attempted"
        );
        let home = fixture.join("home");
        ensure!(
            home.canonicalize()? == home && home_env == Some(home.as_os_str()),
            "acceptance HOME not isolated"
        );
        ensure!(
            auth_env == Some(fixture.join("empty-codex").as_os_str()),
            "acceptance auth home not isolated"
        );
        for directory in [home, fixture.join("empty-codex")] {
            let info = fs::symlink_metadata(&directory)?;
            ensure!(
                info.is_dir()
                    && !info.file_type().is_symlink()
                    && info.permissions().mode() & 0o077 == 0
                    && info.uid() == meta.uid(),
                "acceptance homes must be private owned directories"
            );
        }
        Ok(Self {
            root: root.to_owned(),
            plan,
            started: Instant::now(),
            observations: Mutex::new(BTreeSet::new()),
            auth_probe: Mutex::new(None),
            finishing: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        })
    }
    pub fn identifier(&self) -> String {
        format!(
            "dev.rainmote.qi-acceptance.{}",
            self.plan.fixture_id.replace('-', "")
        )
    }
    pub fn state_directory(&self) -> PathBuf {
        self.root
            .parent()
            .expect("validated fixture parent")
            .join("state")
    }
    pub fn data_store_identifier(&self) -> [u8; 16] {
        *Uuid::parse_str(&self.plan.fixture_id)
            .expect("validated fixture id")
            .as_bytes()
    }
    /// Native WebKit evaluation returns only a bounded, typed observation.
    /// It neither reads credentials nor invokes a renderer capability.
    pub fn observe_auth_probe(&self, raw: &str) -> Result<bool> {
        ensure!(raw.len() <= 4096, "oversized native auth observation");
        let probe: AuthProbe = serde_json::from_str(raw)?;
        ensure!(probe.schema == 1, "unknown native auth observation");
        let complete = probe.complete;
        let passed = probe.passed();
        *self.auth_probe.lock().unwrap() = Some(probe);
        if complete {
            if passed {
                self.record("web_app_authenticated")?;
            } else {
                self.record("startup_failed")?;
            }
        }
        Ok(complete)
    }
    pub fn record(&self, name: &str) -> Result<()> {
        // A failed observation must survive diagnostic I/O failure as well.
        if matches!(name, "startup_failed" | "cleanup_unknown") {
            self.mark_failed();
        }
        ensure!(
            matches!(
                name,
                "window_created"
                    | "host_authenticated_ready"
                    | "web_document_loaded"
                    | "web_app_authenticated"
                    | "startup_failed"
                    | "cleanup_confirmed"
                    | "cleanup_unknown"
            ),
            "unknown acceptance observation"
        );
        if name == "web_app_authenticated" {
            ensure!(
                self.auth_probe
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(AuthProbe::passed),
                "authenticated app requires a successful native probe"
            );
        }
        let mut observations = self.observations.lock().unwrap();
        if !observations.contains(name) {
            let path = self.root.join("events.jsonl");
            if let Ok(meta) = fs::symlink_metadata(&path) {
                ensure!(
                    meta.is_file() && !meta.file_type().is_symlink(),
                    "invalid observation file"
                );
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(path)?;
            let mut event =
                serde_json::json!({"event":name,"elapsed_ms":self.started.elapsed().as_millis()});
            if name == "web_app_authenticated" {
                event["probe"] = serde_json::to_value(&*self.auth_probe.lock().unwrap())?;
            }
            writeln!(file, "{}", event)?;
            file.sync_all()?;
            observations.insert(name.to_owned());
        }
        Ok(())
    }
    /// Record a negative observation under the supervisor lock without I/O.
    pub fn mark_failed(&self) {
        self.failed.store(true, Ordering::SeqCst);
    }
    pub fn page_ready(&self) -> bool {
        let observations = self.observations.lock().unwrap();
        [
            "window_created",
            "host_authenticated_ready",
            "web_document_loaded",
            "web_app_authenticated",
        ]
        .iter()
        .all(|name| observations.contains(*name))
    }
    pub fn finish(&self, cleaned: bool) -> Result<bool> {
        self.record(if cleaned {
            "cleanup_confirmed"
        } else {
            "cleanup_unknown"
        })?;
        let passed = cleaned && self.page_ready() && !self.failed.load(Ordering::SeqCst);
        let value = serde_json::json!({"schema":2,"run_id":self.plan.run_id,"source_sha":self.plan.source_sha,
            "fixture_id":self.plan.fixture_id,"phase":self.plan.phase,
            "controller_sha256":self.plan.controller_sha256,"status":if passed {"NATIVE_AUTH_PASS"}else{"NATIVE_AUTH_FAIL"},
            "observations":*self.observations.lock().unwrap(),"elapsed_ms":self.started.elapsed().as_millis(),
            "auth_probe":*self.auth_probe.lock().unwrap(),
            "scope":"actual packaged native WebKit app DOM + cookie-only bootstrap + graceful cleanup; no model/LCU/full interaction claim",
            "model_calls":0,"lcu_calls":0,"real_project_trust_changes":0,"external_links":0});
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.root.join("result.json"))
            .context("acceptance result cannot overwrite an earlier attempt")?;
        serde_json::to_writer_pretty(&mut file, &value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(passed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, String) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["home", "empty-codex", "phase-1"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let id = Uuid::new_v4().to_string();
        let plan = Plan {
            schema: 2,
            fixture_id: Uuid::new_v4().to_string(),
            phase: 1,
            run_id: id.clone(),
            source_sha: "a".repeat(40),
            controller_sha256: "b".repeat(64),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join("phase-1/plan.json"))
            .unwrap();
        serde_json::to_writer(&mut file, &plan).unwrap();
        (temporary, id)
    }
    fn load(root: &Path, id: &str) -> Result<Acceptance> {
        Acceptance::load_with_homes(
            root,
            id,
            Some(root.parent().unwrap().join("home").as_os_str()),
            Some(root.parent().unwrap().join("empty-codex").as_os_str()),
        )
    }
    #[test]
    fn plan_refuses_shared_homes_stale_runs_and_wrong_identity() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        assert!(load(&root, &Uuid::new_v4().to_string()).is_err());
        assert!(
            Acceptance::load_with_homes(
                &root,
                &id,
                Some(Path::new("/Users/shared").as_os_str()),
                None
            )
            .is_err()
        );
        assert!(load(&root, &id).is_ok());
        fs::write(root.join("result.json"), b"old").unwrap();
        assert!(load(&root, &id).is_err());
    }
    #[test]
    fn finished_document_without_authenticated_app_is_not_ready() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        let mode = load(&root, &id).unwrap();
        for name in [
            "window_created",
            "host_authenticated_ready",
            "web_document_loaded",
        ] {
            mode.record(name).unwrap();
        }
        assert!(
            !mode.page_ready(),
            "a finished 401 JSON document is not an authenticated app"
        );
        assert!(!mode.finish(true).unwrap());
    }
    fn passing_probe() -> serde_json::Value {
        serde_json::json!({"schema":1,"complete":true,"document_html":true,"token_free_url":true,
            "app_shell_visible":true,"draft_view_visible":true,"composer_visible_enabled":true,
            "workspace_bound":true,"bootstrap_status":200,"bootstrap_ok":true,"bootstrap_shape":true,
            "no_sessions":true,"probe_error":false})
    }
    #[test]
    fn native_probe_requires_the_app_dom_and_cookie_only_bootstrap_together() {
        for key in [
            "complete",
            "document_html",
            "token_free_url",
            "app_shell_visible",
            "draft_view_visible",
            "composer_visible_enabled",
            "workspace_bound",
            "bootstrap_ok",
            "bootstrap_shape",
            "no_sessions",
            "bootstrap_status",
            "probe_error",
        ] {
            let (dir, id) = fixture();
            let root = dir.path().canonicalize().unwrap().join("phase-1");
            let mode = load(&root, &id).unwrap();
            let mut probe = passing_probe();
            probe[key] = match key {
                "bootstrap_status" => serde_json::json!(401),
                "probe_error" => serde_json::json!(true),
                _ => serde_json::json!(false),
            };
            for event in [
                "window_created",
                "host_authenticated_ready",
                "web_document_loaded",
            ] {
                mode.record(event).unwrap();
            }
            assert!(mode.record("web_app_authenticated").is_err());
            mode.observe_auth_probe(&probe.to_string()).unwrap();
            assert!(!mode.page_ready(), "missing {key} must not pass");
            assert!(!mode.finish(true).unwrap());
        }
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        let mode = load(&root, &id).unwrap();
        for event in [
            "window_created",
            "host_authenticated_ready",
            "web_document_loaded",
        ] {
            mode.record(event).unwrap();
        }
        assert!(
            mode.observe_auth_probe(&passing_probe().to_string())
                .unwrap()
        );
        assert!(mode.finish(true).unwrap());
        let result: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("result.json")).unwrap()).unwrap();
        assert_eq!(result["auth_probe"], passing_probe());
        assert_eq!(result["status"], "NATIVE_AUTH_PASS");
    }
    #[test]
    fn phases_share_the_private_fixture_but_cannot_reuse_a_result_or_wrong_path() {
        let (dir, id) = fixture();
        let fixture_root = dir.path().canonicalize().unwrap();
        let first = load(&fixture_root.join("phase-1"), &id).unwrap();
        let second_root = fixture_root.join("phase-2");
        fs::create_dir(&second_root).unwrap();
        fs::set_permissions(&second_root, fs::Permissions::from_mode(0o700)).unwrap();
        let mut plan: Plan =
            serde_json::from_slice(&fs::read(first.root.join("plan.json")).unwrap()).unwrap();
        plan.phase = 2;
        plan.run_id = Uuid::new_v4().to_string();
        fs::write(
            second_root.join("plan.json"),
            serde_json::to_vec(&plan).unwrap(),
        )
        .unwrap();
        fs::set_permissions(
            second_root.join("plan.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let second = load(&second_root, &plan.run_id).unwrap();
        assert_eq!(first.identifier(), second.identifier());
        assert_eq!(
            first.data_store_identifier(),
            second.data_store_identifier()
        );
        assert_eq!(first.state_directory(), second.state_directory());
        assert_ne!(first.plan.run_id, second.plan.run_id);
        assert_ne!(first.root, second.root);
        plan.phase = 1;
        fs::write(
            second_root.join("plan.json"),
            serde_json::to_vec(&plan).unwrap(),
        )
        .unwrap();
        assert!(load(&second_root, &plan.run_id).is_err());
    }
    #[test]
    fn observations_do_not_promote_startup_failure_or_unknown_cleanup() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        let mode = load(&root, &id).unwrap();
        for name in [
            "window_created",
            "host_authenticated_ready",
            "web_document_loaded",
            "startup_failed",
        ] {
            mode.record(name).unwrap();
        }
        assert!(!mode.finish(true).unwrap());
        assert!(
            mode.finish(true).is_err(),
            "must not overwrite first attempt"
        );
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        let mode = load(&root, &id).unwrap();
        assert!(!mode.finish(false).unwrap());
    }
    #[test]
    fn failure_is_sticky_even_when_the_negative_event_cannot_be_written() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap().join("phase-1");
        let mode = load(&root, &id).unwrap();
        fs::create_dir(root.join("events.jsonl")).unwrap();
        assert!(mode.record("startup_failed").is_err());
        fs::remove_dir(root.join("events.jsonl")).unwrap();
        for name in [
            "window_created",
            "host_authenticated_ready",
            "web_document_loaded",
        ] {
            mode.record(name).unwrap();
        }
        assert!(!mode.page_ready());
        assert!(!mode.finish(true).unwrap());
    }
}
