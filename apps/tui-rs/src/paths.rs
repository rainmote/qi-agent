use anyhow::{Context, Result, bail};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub runtime_dir: PathBuf,
    pub state_dir: PathBuf,
    pub public_socket: PathBuf,
    pub daemon_lock: PathBuf,
    pub database: PathBuf,
    pub workers_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub client_id: PathBuf,
}

impl RuntimePaths {
    pub fn discover() -> Result<Self> {
        let runtime_dir = if let Some(value) = env::var_os("DAO_RUNTIME_DIR") {
            PathBuf::from(value)
        } else if let Some(value) = env::var_os("XDG_RUNTIME_DIR") {
            PathBuf::from(value).join("dao")
        } else {
            env::temp_dir().join(format!("dao-{}", unsafe { libc::geteuid() }))
        };
        let state_dir = if let Some(value) = env::var_os("DAO_STATE_DIR") {
            PathBuf::from(value)
        } else if let Some(value) = env::var_os("XDG_STATE_HOME") {
            PathBuf::from(value).join("dao")
        } else {
            home_dir()?.join(".local/state/dao")
        };
        let paths = Self {
            public_socket: runtime_dir.join("daemon.sock"),
            daemon_lock: runtime_dir.join("daemon.lock"),
            database: state_dir.join("supervisor.sqlite"),
            workers_dir: state_dir.join("workers"),
            logs_dir: state_dir.join("logs"),
            client_id: state_dir.join("client-id"),
            runtime_dir,
            state_dir,
        };
        paths.ensure()?;
        Ok(paths)
    }

    pub fn ensure(&self) -> Result<()> {
        for path in [
            &self.runtime_dir,
            &self.state_dir,
            &self.workers_dir,
            &self.logs_dir,
        ] {
            fs::create_dir_all(path)
                .with_context(|| format!("could not create {}", path.display()))?;
            set_owner_only_dir(path)?;
        }
        Ok(())
    }

    pub fn worker_socket(&self, worker_id: &str) -> PathBuf {
        // macOS limits Unix-domain socket paths to roughly 104 bytes. Its
        // default per-user temporary directory is already long, so embedding
        // the full worker UUID makes an otherwise normal installation fail.
        // The descriptor and registration still carry the full worker ID;
        // this stable 80-bit name is only a compact filesystem endpoint.
        let digest = Uuid::new_v5(&Uuid::NAMESPACE_OID, worker_id.as_bytes())
            .simple()
            .to_string();
        self.runtime_dir.join(format!("w-{}.sock", &digest[..20]))
    }

    pub fn worker_descriptor(&self, worker_id: &str) -> PathBuf {
        self.workers_dir.join(format!("{worker_id}.json"))
    }
}

pub fn canonical(path: impl AsRef<Path>) -> Result<PathBuf> {
    path.as_ref()
        .canonicalize()
        .with_context(|| format!("path does not exist: {}", path.as_ref().display()))
}

pub fn discover_repository_root(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return canonical(path);
    }
    if let Some(value) = env::var_os("DAO_REPOSITORY_ROOT") {
        return canonical(value);
    }
    let mut starts = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(executable) = env::current_exe()
        && let Some(parent) = executable.parent()
    {
        starts.push(parent.to_path_buf());
    }
    for start in starts {
        for ancestor in start.ancestors() {
            if ancestor.join("bb.edn").is_file() && ancestor.join("src/agent/cli.clj").is_file() {
                return canonical(ancestor);
            }
        }
    }
    bail!("could not locate the dao repository root; set DAO_REPOSITORY_ROOT")
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is unavailable and XDG_STATE_HOME is not set")
}

#[cfg(unix)]
pub fn set_owner_only_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("could not protect {}", path.display()))
}

#[cfg(unix)]
pub fn set_owner_only_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("could not protect {}", path.display()))
}

#[cfg(not(unix))]
pub fn set_owner_only_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub fn set_owner_only_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    fn paths(runtime_dir: PathBuf) -> RuntimePaths {
        RuntimePaths {
            public_socket: runtime_dir.join("daemon.sock"),
            daemon_lock: runtime_dir.join("daemon.lock"),
            database: runtime_dir.join("state/supervisor.sqlite"),
            workers_dir: runtime_dir.join("state/workers"),
            logs_dir: runtime_dir.join("state/logs"),
            client_id: runtime_dir.join("state/client-id"),
            state_dir: runtime_dir.join("state"),
            runtime_dir,
        }
    }

    #[test]
    fn worker_socket_stays_below_the_macos_sun_len_limit() {
        let runtime = PathBuf::from("/var/folders/fg/v9z1bzlj0g96pcgpmg2ht3b80000gn/T/dao-501");
        let socket = paths(runtime).worker_socket("worker-e8e646b7-3451-4c9d-97b6-8cecf266ca11");
        assert!(socket.as_os_str().as_bytes().len() < 104, "{socket:?}");
    }

    #[test]
    fn worker_socket_names_are_stable_and_distinct() {
        let paths = paths(PathBuf::from("/tmp/dao-501"));
        let first = paths.worker_socket("worker-00000000-0000-0000-0000-000000000001");
        assert_eq!(
            first,
            paths.worker_socket("worker-00000000-0000-0000-0000-000000000001")
        );
        assert_ne!(
            first,
            paths.worker_socket("worker-00000000-0000-0000-0000-000000000002")
        );
    }
}
