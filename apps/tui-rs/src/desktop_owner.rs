//! Opt-in parent lifetime for a foreground daemon owned by the desktop shell.
//! No process enumeration, permissive fallback, or change to normal daemons.
use anyhow::{Result, bail};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

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

#[cfg(test)]
mod tests {
    use super::*;
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
}
