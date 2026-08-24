use anyhow::{Context, Result, bail};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

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
        self.runtime_dir.join(format!("worker-{worker_id}.sock"))
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
