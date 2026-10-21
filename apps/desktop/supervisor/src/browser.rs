//! Sidebar browsing is a user surface, not an agent tool or an execution grant.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use url::Url;
use uuid::Uuid;

pub const MAX_TABS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn validate(self, width: f64, height: f64) -> Result<Self> {
        ensure!(
            [self.x, self.y, self.width, self.height, width, height]
                .iter()
                .all(|n| n.is_finite()),
            "invalid browser bounds"
        );
        ensure!(
            self.x >= 0.0
                && self.y >= 0.0
                && self.width >= 1.0
                && self.height >= 1.0
                && self.x + self.width <= width + 1.0
                && self.y + self.height <= height + 1.0,
            "browser bounds leave the main window"
        );
        Ok(self)
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub action: String,
    pub workspace: String,
    pub lease: Option<String>,
    pub url: Option<String>,
    pub bounds: Option<Bounds>,
}

impl Request {
    pub fn parse(raw: &str) -> Result<Self> {
        ensure!(raw.len() <= 16384, "oversized browser request");
        let request: Self = serde_json::from_str(raw)?;
        ensure!(
            Uuid::parse_str(&request.id).is_ok(),
            "invalid request identity"
        );
        ensure!(
            request.workspace.len() == 16
                && request.workspace.bytes().all(|c| c.is_ascii_hexdigit()),
            "invalid workspace identity"
        );
        ensure!(
            matches!(
                request.action.as_str(),
                "acquire"
                    | "navigate"
                    | "back"
                    | "forward"
                    | "reload"
                    | "bounds"
                    | "hide"
                    | "release"
                    | "status"
            ),
            "unknown browser action"
        );
        Ok(request)
    }
}

#[derive(Clone, Serialize)]
pub struct Lease {
    pub id: String,
    pub workspace: String,
    pub generation: u64,
    pub label: String,
}

#[derive(Default)]
pub struct Leases {
    tabs: BTreeMap<String, Lease>,
}

impl Leases {
    pub fn acquire(&mut self, workspace: &str, generation: u64) -> Result<Lease> {
        ensure!(
            self.tabs.len() < MAX_TABS,
            "close an existing browser tab first"
        );
        let id = Uuid::new_v4().to_string();
        let lease = Lease {
            label: format!("browser-{id}"),
            id: id.clone(),
            workspace: workspace.to_owned(),
            generation,
        };
        self.tabs.insert(id, lease.clone());
        Ok(lease)
    }
    pub fn get(&self, id: &str, workspace: &str, generation: u64) -> Result<Lease> {
        let lease = self
            .tabs
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("browser lease no longer exists"))?;
        ensure!(
            lease.workspace == workspace && lease.generation == generation,
            "browser lease belongs to another workspace or generation"
        );
        Ok(lease.clone())
    }
    pub fn release(&mut self, id: &str, workspace: &str, generation: u64) -> Result<Option<Lease>> {
        if !self.tabs.contains_key(id) {
            return Ok(None);
        }
        self.get(id, workspace, generation)?;
        Ok(self.tabs.remove(id))
    }
    pub fn drain(&mut self) -> Vec<Lease> {
        std::mem::take(&mut self.tabs).into_values().collect()
    }
}

/// The authenticated application is never a browsing target, including aliases.
/// This is not advertised as a general DNS rebinding/private-network firewall.
pub fn target(raw: &str, application: &str) -> Result<Url> {
    ensure!(
        raw.len() <= 4096 && !raw.chars().any(char::is_control),
        "invalid browser address"
    );
    let raw = raw.trim();
    let normalized = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&normalized)?;
    ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        "browser accepts HTTP(S) only"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "URL credentials are not allowed"
    );
    let host = Url::parse(application)?;
    let alias = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    ensure!(
        !(url.port_or_known_default() == host.port_or_known_default()
            && (url.host_str() == host.host_str() || alias)),
        "application Host cannot be opened in a guest"
    );
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_are_opaque_scoped_and_released_without_cross_workspace_access() {
        let mut leases = Leases::default();
        let a = leases.acquire("0123456789abcdef", 3).unwrap();
        assert!(leases.get(&a.id, "aaaaaaaaaaaaaaaa", 3).is_err());
        assert!(leases.get(&a.id, &a.workspace, 4).is_err());
        assert!(leases.release(&a.id, "aaaaaaaaaaaaaaaa", 3).is_err());
        assert!(leases.get(&a.id, &a.workspace, 3).is_ok());
        assert!(leases.release(&a.id, &a.workspace, 3).unwrap().is_some());
        assert!(leases.release(&a.id, &a.workspace, 3).unwrap().is_none());
        assert!(leases.get(&a.id, &a.workspace, 3).is_err());
    }
    #[test]
    fn browser_never_accepts_the_authenticated_host_or_native_schemes() {
        let app = "http://127.0.0.1:32123";
        for value in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "data:text/html,a",
            "https://user:password@example.com",
            "http://127.1:32123",
            "http://localhost:32123",
            "http://[::1]:32123",
            "http://127.0.0.1:32123",
        ] {
            assert!(target(value, app).is_err(), "{value}");
        }
        assert_eq!(
            target("example.com/path", app).unwrap().as_str(),
            "https://example.com/path"
        );
        assert!(target("http://localhost:8000", app).is_ok());
    }
    #[test]
    fn native_child_geometry_cannot_cover_unrelated_windows() {
        assert!(
            Bounds {
                x: 10.0,
                y: 80.0,
                width: 400.0,
                height: 500.0
            }
            .validate(1280.0, 840.0)
            .is_ok()
        );
        for b in [
            Bounds {
                x: -1.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            Bounds {
                x: 0.0,
                y: 0.0,
                width: f64::NAN,
                height: 10.0,
            },
            Bounds {
                x: 900.0,
                y: 0.0,
                width: 900.0,
                height: 10.0,
            },
        ] {
            assert!(b.validate(1280.0, 840.0).is_err());
        }
    }
    #[test]
    fn tab_quota_and_generation_cleanup_are_bounded() {
        let mut leases = Leases::default();
        for _ in 0..MAX_TABS {
            leases.acquire("0123456789abcdef", 1).unwrap();
        }
        assert!(leases.acquire("0123456789abcdef", 1).is_err());
        assert_eq!(leases.drain().len(), MAX_TABS);
        assert!(leases.drain().is_empty());
        assert!(leases.acquire("0123456789abcdef", 2).is_ok());
    }
}
