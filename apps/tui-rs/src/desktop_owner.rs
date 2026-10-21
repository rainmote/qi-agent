//! Opt-in parent lifetime for a foreground daemon owned by the desktop shell.
//! No process enumeration, permissive fallback, or change to normal daemons.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OwnedHelper {
    pub pid: u32,
    pub parent: u32,
    pub started_sec: u64,
    pub started_usec: u64,
}

pub fn admit_helper(parent: u32, observed: OwnedHelper) -> Result<OwnedHelper> {
    if parent <= 2
        || observed.pid <= 2
        || observed.pid == parent
        || observed.parent != parent
        || observed.started_sec == 0
        || observed.started_usec >= 1_000_000
    {
        bail!("helper parent/identity could not be verified");
    }
    Ok(observed)
}

#[cfg(target_os = "macos")]
pub fn helper_identity(pid: u32) -> Result<Option<OwnedHelper>> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid.try_into()?,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size.try_into()?,
        )
    };
    if count == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error.into());
    }
    if count != size as i32 || info.pbi_pid != pid {
        bail!("helper process observation UNKNOWN");
    }
    Ok(Some(OwnedHelper {
        pid,
        parent: info.pbi_ppid,
        started_sec: info.pbi_start_tvsec,
        started_usec: info.pbi_start_tvusec,
    }))
}

#[cfg(not(target_os = "macos"))]
pub fn helper_identity(_pid: u32) -> Result<Option<OwnedHelper>> {
    bail!("guarded PTY admission is not supported on this target")
}

pub fn helper_present(owned: &OwnedHelper) -> Result<bool> {
    Ok(helper_identity(owned.pid)?.is_some_and(|now| {
        now.started_sec == owned.started_sec && now.started_usec == owned.started_usec
    }))
}

pub fn helpers_absent(helpers: &[OwnedHelper]) -> Result<bool> {
    for owned in helpers {
        if helper_present(owned)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The check must follow the shared residency lock. An already admitted
/// process can finish publishing; cleanup takes the same lock before its
/// snapshot. No desktop process may be admitted behind that snapshot.
pub fn process_admission<'a>(
    owned: bool,
    closing: &AtomicBool,
    residency: &'a Mutex<()>,
) -> Result<MutexGuard<'a, ()>> {
    let guard = residency.lock().expect("runtime residency mutex poisoned");
    if owned && closing.load(Ordering::SeqCst) {
        bail!("desktop daemon is stopping; no new process may start");
    }
    Ok(guard)
}

pub fn drain_processes(owned: bool, residency: &Mutex<()>) -> Option<MutexGuard<'_, ()>> {
    owned.then(|| residency.lock().expect("runtime residency mutex poisoned"))
}

/// Only ESRCH proves absence. Permission and interrupted observations remain
/// unknown; they must never authorize clearing a process identity or lease.
pub fn presence_result(result: i32, errno: i32) -> Result<bool> {
    if result == 0 {
        return Ok(true);
    }
    if result == -1 && errno == libc::ESRCH {
        return Ok(false);
    }
    bail!(
        "process presence UNKNOWN: {}",
        std::io::Error::from_raw_os_error(errno)
    );
}

pub fn signal_target(pid: u32, group: bool) -> Result<i32> {
    if pid <= 1 {
        bail!("invalid desktop process identity");
    }
    let pid = i32::try_from(pid)?;
    Ok(if group { -pid } else { pid })
}

pub fn process_presence(pid: u32, group: bool) -> Result<bool> {
    let target = signal_target(pid, group)?;
    let result = unsafe { libc::kill(target, 0) };
    presence_result(
        result,
        if result == 0 {
            0
        } else {
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO)
        },
    )
}

pub fn validate_parent(raw: Option<&str>, actual_parent: u32) -> Result<Option<u32>> {
    let Some(raw) = raw else { return Ok(None) };
    let expected: u32 = raw.parse()?;
    if expected <= 1 || expected != actual_parent {
        bail!("desktop daemon parent identity does not match its actual parent");
    }
    Ok(Some(expected))
}

pub fn shutdown_receipt(directory: &Path, run_id: &str, errors: &[String]) -> Result<()> {
    uuid::Uuid::parse_str(run_id)?;
    let temporary = directory.join(format!(".desktop-shutdown-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let data = json!({"run_id": run_id, "ok": errors.is_empty(), "errors": errors});
    file.write_all(&serde_json::to_vec(&data)?)?;
    file.sync_all()?;
    fs::rename(temporary, directory.join("desktop-shutdown.json"))?;
    Ok(())
}

/// Preserve fresh-child identity even if its ordinary descriptor cannot be
/// read or a later cleanup path changes it. This is evidence, not a success.
pub fn failed_start_identity(directory: &Path, descriptor: &Path, pid: u32) -> Result<PathBuf> {
    let id = uuid::Uuid::new_v4();
    let temporary = directory.join(format!(".desktop-failed-start-{id}.tmp"));
    let destination = directory.join(format!("desktop-failed-start-{id}.json"));
    let snapshot = fs::read(descriptor)
        .ok()
        .filter(|bytes| bytes.len() <= 524288)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let data = json!({"status":"UNKNOWN", "spawned_pid":pid, "descriptor_path":descriptor, "descriptor":snapshot});
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(&data)?)?;
    file.sync_all()?;
    fs::rename(temporary, &destination)?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_guardian_admission_rejects_foreign_parent_and_invalid_identity() {
        let valid = OwnedHelper {
            pid: 23456,
            parent: 12345,
            started_sec: 100,
            started_usec: 20,
        };
        assert_eq!(admit_helper(12345, valid.clone()).unwrap(), valid);
        assert!(admit_helper(12346, valid.clone()).is_err());
        assert!(admit_helper(23456, valid.clone()).is_err());
        assert!(
            admit_helper(
                12345,
                OwnedHelper {
                    started_sec: 0,
                    ..valid.clone()
                }
            )
            .is_err()
        );
        assert!(admit_helper(12345, OwnedHelper { pid: 1, ..valid }).is_err());
    }
    #[test]
    fn desktop_parent_is_opt_in_and_never_adopts_an_arbitrary_pid() {
        assert_eq!(validate_parent(None, 1).unwrap(), None);
        assert_eq!(validate_parent(Some("123"), 123).unwrap(), Some(123));
        for raw in ["0", "1", "124", "-1", "bad"] {
            assert!(validate_parent(Some(raw), 123).is_err());
        }
    }
    #[test]
    fn shutdown_receipt_preserves_failure_and_private_run_identity() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("qi-desktop-receipt-unit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let run_id = uuid::Uuid::new_v4().to_string();
        let path = directory.join("desktop-shutdown.json");
        shutdown_receipt(&directory, &run_id, &["worker cleanup failed".into()]).unwrap();
        let failed: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(failed["run_id"], run_id);
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["errors"].as_array().unwrap().len(), 1);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        assert!(shutdown_receipt(&directory, "not-a-run", &[]).is_err());
        shutdown_receipt(&directory, &run_id, &[]).unwrap();
        let clean: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(clean["ok"], true);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn shutdown_drains_admitted_processes_and_refuses_later_desktop_starts() {
        use std::sync::{Arc, mpsc};
        let residency = Arc::new(Mutex::new(()));
        let closing = AtomicBool::new(false);
        let published = Arc::new(Mutex::new(Vec::new()));
        let admitted = process_admission(true, &closing, &residency).unwrap();
        closing.store(true, Ordering::SeqCst);
        let (entered, receive) = mpsc::sync_channel(1);
        let lock = Arc::clone(&residency);
        let values = Arc::clone(&published);
        let snapshot = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let _drained = drain_processes(true, &lock);
            values.lock().unwrap().clone()
        });
        receive.recv().unwrap();
        assert!(residency.try_lock().is_err());
        published.lock().unwrap().push("admitted-before-shutdown");
        drop(admitted);
        assert_eq!(snapshot.join().unwrap(), vec!["admitted-before-shutdown"]);
        assert!(process_admission(true, &closing, &residency).is_err());
        // Non-desktop daemons retain their existing admission behavior.
        assert!(process_admission(false, &closing, &residency).is_ok());
    }
    #[test]
    fn failed_start_record_retains_fallback_and_original_descriptor() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("qi-desktop-identity-unit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let descriptor = directory.join("worker.json");
        let original = br#"{"pid":null,"child_pid":789,"child_process_group":789}"#;
        fs::write(&descriptor, original).unwrap();
        let record = failed_start_identity(&directory, &descriptor, 123).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
        assert_eq!(value["status"], "UNKNOWN");
        assert_eq!(value["spawned_pid"], 123);
        assert_eq!(value["descriptor"]["child_process_group"], 789);
        assert_eq!(fs::read(&descriptor).unwrap(), original);
        assert_eq!(
            fs::metadata(record).unwrap().permissions().mode() & 0o077,
            0
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn only_esrch_proves_absence_without_running_an_os_probe() {
        assert!(presence_result(0, 0).unwrap());
        assert!(!presence_result(-1, libc::ESRCH).unwrap());
        for errno in [
            libc::EPERM,
            libc::EACCES,
            libc::EINTR,
            libc::EINVAL,
            libc::EIO,
        ] {
            assert!(presence_result(-1, errno).is_err());
        }
        assert_eq!(signal_target(123, false).unwrap(), 123);
        assert_eq!(signal_target(123, true).unwrap(), -123);
        for invalid in [0, 1, u32::MAX] {
            assert!(signal_target(invalid, true).is_err());
        }
    }
}
