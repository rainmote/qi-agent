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
}

pub struct Acceptance {
    pub root: PathBuf,
    pub plan: Plan,
    started: Instant,
    observations: Mutex<BTreeSet<String>>,
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
            plan.schema == 1 && plan.run_id == run_id && Uuid::parse_str(run_id).is_ok(),
            "acceptance run mismatch"
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
        let home = root.join("home");
        ensure!(
            home.canonicalize()? == home && home_env == Some(home.as_os_str()),
            "acceptance HOME not isolated"
        );
        ensure!(
            auth_env == Some(root.join("empty-codex").as_os_str()),
            "acceptance auth home not isolated"
        );
        for directory in [home, root.join("empty-codex")] {
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
            finishing: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        })
    }
    pub fn identifier(&self) -> String {
        format!(
            "dev.rainmote.qi-acceptance.{}",
            self.plan.run_id.replace('-', "")
        )
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
                    | "startup_failed"
                    | "cleanup_confirmed"
                    | "cleanup_unknown"
            ),
            "unknown acceptance observation"
        );
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
            writeln!(
                file,
                "{}",
                serde_json::json!({"event":name,"elapsed_ms":self.started.elapsed().as_millis()})
            )?;
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
        let value = serde_json::json!({"schema":1,"run_id":self.plan.run_id,"source_sha":self.plan.source_sha,
            "controller_sha256":self.plan.controller_sha256,"status":if passed {"COLD_START_SMOKE_PASS"}else{"COLD_START_SMOKE_FAIL"},
            "observations":*self.observations.lock().unwrap(),"elapsed_ms":self.started.elapsed().as_millis(),
            "scope":"actual packaged native window + Host/daemon + Web document + graceful cleanup only; no worker/model/LCU/desktop-input or full E2E claim",
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
        for name in ["home", "empty-codex"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let id = Uuid::new_v4().to_string();
        let plan = Plan {
            schema: 1,
            run_id: id.clone(),
            source_sha: "a".repeat(40),
            controller_sha256: "b".repeat(64),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join("plan.json"))
            .unwrap();
        serde_json::to_writer(&mut file, &plan).unwrap();
        (temporary, id)
    }
    fn load(root: &Path, id: &str) -> Result<Acceptance> {
        Acceptance::load_with_homes(
            root,
            id,
            Some(root.join("home").as_os_str()),
            Some(root.join("empty-codex").as_os_str()),
        )
    }
    #[test]
    fn plan_refuses_shared_homes_stale_runs_and_wrong_identity() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap();
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
    fn observations_do_not_promote_startup_failure_or_unknown_cleanup() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap();
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
        let root = dir.path().canonicalize().unwrap();
        let mode = load(&root, &id).unwrap();
        assert!(!mode.finish(false).unwrap());
    }
    #[test]
    fn failure_is_sticky_even_when_the_negative_event_cannot_be_written() {
        let (dir, id) = fixture();
        let root = dir.path().canonicalize().unwrap();
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
        assert!(mode.page_ready());
        assert!(!mode.finish(true).unwrap());
    }
}
