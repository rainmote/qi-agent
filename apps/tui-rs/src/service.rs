use crate::paths::{RuntimePaths, set_owner_only_file};
use anyhow::{Context, Result, bail};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

const LAUNCHD_LABEL: &str = "io.github.rainmote.qi-agent";
const SYSTEMD_UNIT: &str = "qi-agent.service";

pub enum ServiceAction {
    Print,
    Install,
    Uninstall,
}

pub fn manage(
    action: ServiceAction,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<String> {
    let executable = env::current_exe()?.canonicalize()?;
    let paths = RuntimePaths::discover()?;
    let definition = definition(&executable, repository_root, config_path, &paths)?;
    match action {
        ServiceAction::Print => Ok(definition.contents),
        ServiceAction::Install => {
            if let Some(parent) = definition.path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&definition.path, &definition.contents)
                .with_context(|| format!("could not write {}", definition.path.display()))?;
            set_owner_only_file(&definition.path)?;
            activate(&definition)?;
            Ok(format!(
                "installed and started {} at {}",
                definition.name,
                definition.path.display()
            ))
        }
        ServiceAction::Uninstall => {
            deactivate(&definition);
            if definition.path.exists() {
                fs::remove_file(&definition.path)?;
            }
            Ok(format!("uninstalled {}", definition.name))
        }
    }
}

struct ServiceDefinition {
    name: &'static str,
    path: PathBuf,
    contents: String,
    kind: ServiceKind,
}

enum ServiceKind {
    Launchd,
    Systemd,
}

fn definition(
    executable: &Path,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
    paths: &RuntimePaths,
) -> Result<ServiceDefinition> {
    if cfg!(target_os = "macos") {
        let path = home_dir()?
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"));
        let mut arguments = vec![
            executable.display().to_string(),
            "daemon".into(),
            "serve".into(),
        ];
        append_runtime_arguments(&mut arguments, repository_root, config_path);
        let argument_xml = arguments
            .iter()
            .map(|argument| format!("      <string>{}</string>", xml_escape(argument)))
            .collect::<Vec<_>>()
            .join("\n");
        let contents = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
  <dict>\n\
    <key>Label</key><string>{LAUNCHD_LABEL}</string>\n\
    <key>ProgramArguments</key>\n\
    <array>\n{argument_xml}\n    </array>\n\
    <key>RunAtLoad</key><true/>\n\
    <key>KeepAlive</key><true/>\n\
    <key>ProcessType</key><string>Background</string>\n\
    <key>StandardOutPath</key><string>{}</string>\n\
    <key>StandardErrorPath</key><string>{}</string>\n\
  </dict>\n\
</plist>\n",
            xml_escape(&paths.logs_dir.join("daemon.log").display().to_string()),
            xml_escape(
                &paths
                    .logs_dir
                    .join("daemon.error.log")
                    .display()
                    .to_string()
            ),
        );
        return Ok(ServiceDefinition {
            name: LAUNCHD_LABEL,
            path,
            contents,
            kind: ServiceKind::Launchd,
        });
    }
    if cfg!(target_os = "linux") {
        let config_home = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or(home_dir()?.join(".config"));
        let path = config_home.join("systemd/user").join(SYSTEMD_UNIT);
        let mut arguments = vec![shell_escape(&executable.display().to_string())];
        arguments.push("daemon".into());
        arguments.push("serve".into());
        if let Some(root) = repository_root {
            arguments.push("--repository-root".into());
            arguments.push(shell_escape(&root.display().to_string()));
        }
        if let Some(config) = config_path {
            arguments.push("--config".into());
            arguments.push(shell_escape(&config.display().to_string()));
        }
        let contents = format!(
            "[Unit]\nDescription=qì agent local supervisor\nAfter=network.target\n\n\
[Service]\nType=simple\nExecStart={}\nRestart=on-failure\nRestartSec=1\n\
StandardOutput=append:{}\nStandardError=append:{}\n\n\
[Install]\nWantedBy=default.target\n",
            arguments.join(" "),
            paths.logs_dir.join("daemon.log").display(),
            paths.logs_dir.join("daemon.error.log").display(),
        );
        return Ok(ServiceDefinition {
            name: SYSTEMD_UNIT,
            path,
            contents,
            kind: ServiceKind::Systemd,
        });
    }
    bail!("OS service installation is supported on macOS and Linux")
}

fn append_runtime_arguments(
    arguments: &mut Vec<String>,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) {
    if let Some(root) = repository_root {
        arguments.push("--repository-root".into());
        arguments.push(root.display().to_string());
    }
    if let Some(config) = config_path {
        arguments.push("--config".into());
        arguments.push(config.display().to_string());
    }
}

fn activate(definition: &ServiceDefinition) -> Result<()> {
    match definition.kind {
        ServiceKind::Launchd => {
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            let _ = Command::new("launchctl")
                .args(["bootout", &domain])
                .arg(&definition.path)
                .status();
            let status = Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(&definition.path)
                .status()?;
            if !status.success() {
                bail!("launchctl bootstrap failed")
            }
        }
        ServiceKind::Systemd => {
            let reload = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .status()?;
            let enable = Command::new("systemctl")
                .args(["--user", "enable", "--now", SYSTEMD_UNIT])
                .status()?;
            if !reload.success() || !enable.success() {
                bail!("systemd user service activation failed")
            }
        }
    }
    Ok(())
}

fn deactivate(definition: &ServiceDefinition) {
    match definition.kind {
        ServiceKind::Launchd => {
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            let _ = Command::new("launchctl")
                .args(["bootout", &domain])
                .arg(&definition.path)
                .status();
        }
        ServiceKind::Systemd => {
            let _ = Command::new("systemctl")
                .args(["--user", "disable", "--now", SYSTEMD_UNIT])
                .status();
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .status();
        }
    }
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is unavailable")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_service_arguments() {
        assert_eq!(xml_escape("a&<b>"), "a&amp;&lt;b&gt;");
        assert_eq!(shell_escape("a'b"), "'a'\\''b'");
    }
}
