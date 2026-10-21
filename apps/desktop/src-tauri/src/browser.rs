//! A native, user-operated sidebar browser. No guest receives application IPC.
use qi_desktop_supervisor::browser::{Bounds, Leases, Request, target};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{
    Manager, WebviewUrl,
    webview::{NewWindowResponse, PermissionResponse, WebviewBuilder},
};

#[derive(Default)]
pub struct Browser {
    leases: Mutex<Leases>,
    uncertain: AtomicBool,
    visibility: AtomicU64,
    document: AtomicU64,
    navigation: Mutex<BTreeMap<String, (u64, bool)>>,
    completed: Mutex<BTreeMap<String, u64>>,
}

fn reply(app: &tauri::AppHandle, id: &str, result: Result<Value, String>) {
    if let Some(main) = app.get_webview_window("main") {
        let value = match result {
            Ok(value) => json!({"id":id,"ok":true,"result":value}),
            Err(error) => json!({"id":id,"ok":false,"error":error}),
        };
        let _ = main.eval(format!(
            "window.dispatchEvent(new CustomEvent('qi-browser-response',{{detail:{value}}}));"
        ));
    }
}

fn update(app: &tauri::AppHandle, lease: &str, value: Value) {
    if let Some(main) = app.get_webview_window("main") {
        let detail = json!({"lease":lease,"state":value});
        let _ = main.eval(format!(
            "window.dispatchEvent(new CustomEvent('qi-browser-state',{{detail:{detail}}}));"
        ));
    }
}

fn acquire_failed(
    app: &tauri::AppHandle,
    request_id: &str,
    lease: &qi_desktop_supervisor::browser::Lease,
    error: &str,
) {
    if let Some(view) = app.get_webview(&lease.label) {
        if view.hide().is_err() || view.close().is_err() {
            app.state::<Browser>()
                .uncertain
                .store(true, Ordering::SeqCst);
            if let Some(main) = app.get_webview_window("main") {
                let value = json!({"id":request_id,"ok":false,"error":"browser cleanup unconfirmed; close this tab before another operation","lease":lease.id,"uncertain":true});
                let _=main.eval(format!("window.dispatchEvent(new CustomEvent('qi-browser-response',{{detail:{value}}}));"));
            }
            return;
        }
    }
    let _ = app.state::<Browser>().leases.lock().unwrap().release(
        &lease.id,
        &lease.workspace,
        lease.generation,
    );
    reply(app, request_id, Err(error.to_owned()));
}

/// Only the authenticated main document may request finite browser operations.
/// The private scheme is intercepted, never registered with the operating system.
pub fn intercept(app: &tauri::AppHandle, url: &tauri::Url) -> bool {
    if url.scheme() != "qi-browser" {
        return false;
    }
    let shell = app.state::<std::sync::Arc<super::Shell>>();
    let origin = shell.origin.read().unwrap().clone();
    if shell.acceptance.is_some()
        || shell.quitting.load(std::sync::atomic::Ordering::SeqCst)
        || origin.is_none()
        || app
            .get_webview_window("main")
            .and_then(|w| w.url().ok())
            .map(|u| u.origin().ascii_serialization())
            != origin
    {
        return true;
    }
    if url.as_str().len() > 32768 || url.host_str() != Some("request") {
        return true;
    }
    let Some(raw) = url
        .query_pairs()
        .find(|(key, _)| key == "data")
        .map(|(_, value)| value.into_owned())
    else {
        return true;
    };
    let Ok(request) = Request::parse(&raw) else {
        return true;
    };
    let broker = app.state::<Browser>();
    if request.action == "present" {
        if let Some(epoch) = request.visibility {
            broker.visibility.fetch_max(epoch, Ordering::SeqCst);
        } else {
            return true;
        }
    }
    let document = broker.document.load(Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if document != handle.state::<Browser>().document.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = operate(&handle, &request) {
            reply(&handle, &request.id, Err(error));
        }
    });
    true
}

fn operate(app: &tauri::AppHandle, request: &Request) -> Result<(), String> {
    let shell = app.state::<std::sync::Arc<super::Shell>>();
    let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
    let origin = shell
        .origin
        .read()
        .unwrap()
        .clone()
        .ok_or("local Host unavailable")?;
    if shell.acceptance.is_some() || shell.quitting.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("browser unavailable during transition".into());
    }
    let broker = app.state::<Browser>();
    if broker.uncertain.load(Ordering::SeqCst)
        && !matches!(
            request.action.as_str(),
            "release" | "present" | "abandon" | "cleanup" | "status"
        )
    {
        return Err(
            "browser cleanup is unconfirmed; use Clean all browser tabs before another operation"
                .into(),
        );
    }
    if request.action == "cleanup" {
        broker.document.fetch_add(1, Ordering::SeqCst);
        close_all(app)?;
        reply(app, &request.id, Ok(json!({"released":true})));
        return Ok(());
    }
    if request.action == "present" {
        if request.visibility != Some(broker.visibility.load(Ordering::SeqCst)) {
            reply(app, &request.id, Ok(json!({"stale":true})));
            return Ok(());
        }
        let snapshot = broker.leases.lock().unwrap().snapshot();
        for item in snapshot {
            if let Some(view) = app.get_webview(&item.label) {
                if view.hide().is_err() {
                    broker.uncertain.store(true, Ordering::SeqCst);
                    return Err("browser visibility UNKNOWN; use Clean all browser tabs".into());
                }
            }
        }
        if let Some(id) = request.lease.as_deref() {
            if broker.uncertain.load(Ordering::SeqCst) {
                return Err("browser cleanup UNKNOWN; cannot present a guest".into());
            }
            let lease = broker
                .leases
                .lock()
                .unwrap()
                .get(id, &request.workspace, generation)
                .map_err(|e| e.to_string())?;
            if broker
                .navigation
                .lock()
                .unwrap()
                .get(id)
                .is_some_and(|(_, unknown)| *unknown)
            {
                return Err("browser process disconnected; close or clean the tab".into());
            }
            let view = app
                .get_webview(&lease.label)
                .ok_or("browser guest unavailable")?;
            let b = validated_bounds(app, request.bounds.ok_or("bounds required")?)?;
            view.set_position(tauri::LogicalPosition::new(b.x, b.y))
                .map_err(|e| e.to_string())?;
            view.set_size(tauri::LogicalSize::new(b.width, b.height))
                .map_err(|e| e.to_string())?;
            view.show().map_err(|e| e.to_string())?;
        }
        reply(app, &request.id, Ok(json!({"visible":request.lease})));
        return Ok(());
    }
    if request.action == "abandon" {
        let lease = broker
            .leases
            .lock()
            .unwrap()
            .abandon(
                request
                    .acquisition
                    .as_deref()
                    .ok_or("acquisition required")?,
                &request.workspace,
                generation,
            )
            .map_err(|e| e.to_string())?;
        if let Some(lease) = lease {
            close_lease(app, &lease)?;
        }
        reply(app, &request.id, Ok(json!({"released":true})));
        return Ok(());
    }
    if request.action == "acquire" {
        let bounds = validated_bounds(app, request.bounds.ok_or("browser bounds required")?)?;
        let url = if let Some(raw) = &request.url {
            Some(target(raw, &origin).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let (lease, fresh) = broker
            .leases
            .lock()
            .unwrap()
            .reserve(&request.id, &request.workspace, generation)
            .map_err(|e| e.to_string())?;
        if !fresh {
            if app.get_webview(&lease.label).is_some() {
                reply(app, &request.id, Ok(json!({"lease":lease.id})));
            }
            return Ok(());
        }
        broker
            .navigation
            .lock()
            .unwrap()
            .insert(lease.id.clone(), (0, false));
        if let Err(error) = create_guest(
            app.clone(),
            request.id.clone(),
            lease.clone(),
            bounds,
            url,
            origin,
        ) {
            acquire_failed(app, &request.id, &lease, &error);
        }
        return Ok(());
    }
    let id = request.lease.as_deref().ok_or("browser lease required")?;
    if request.action == "release" {
        let lease = broker
            .leases
            .lock()
            .unwrap()
            .get(id, &request.workspace, generation);
        // A repeated release is harmless. A foreign live lease is still rejected.
        if let Ok(lease) = lease {
            close_lease(app, &lease)?;
        }
        broker
            .leases
            .lock()
            .unwrap()
            .release(id, &request.workspace, generation)
            .map_err(|e| e.to_string())?;
        if broker.leases.lock().unwrap().is_empty() {
            broker.uncertain.store(false, Ordering::SeqCst);
        }
        reply(app, &request.id, Ok(json!({"released":true})));
        return Ok(());
    }
    let lease = broker
        .leases
        .lock()
        .unwrap()
        .get(id, &request.workspace, generation)
        .map_err(|e| e.to_string())?;
    let view = app
        .get_webview(&lease.label)
        .ok_or("browser guest is unavailable; close this tab")?;
    if broker
        .navigation
        .lock()
        .unwrap()
        .get(id)
        .is_some_and(|(_, unknown)| *unknown)
    {
        return Err(
            "browser process disconnected; close or clean the tab before explicit restore".into(),
        );
    }
    if request.action != "status" {
        if let Some((revision, _)) = broker.navigation.lock().unwrap().get_mut(id) {
            *revision += 1;
        }
    }
    match request.action.as_str() {
        "navigate" => {
            let url = target(request.url.as_deref().ok_or("address required")?, &origin)
                .map_err(|e| e.to_string())?;
            view.navigate(url).map_err(|e| e.to_string())?;
        }
        "reload" => view.reload().map_err(|e| e.to_string())?,
        "back" | "forward" => history(&view, request.action == "back")?,
        "status" => {}
        _ => return Err("unsupported browser action".into()),
    }
    observe(app.clone(), id.to_owned(), Some(request.id.clone()));
    Ok(())
}

fn validated_bounds(app: &tauri::AppHandle, bounds: Bounds) -> Result<Bounds, String> {
    let window = app.get_window("main").ok_or("main window unavailable")?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    bounds
        .validate(size.width, size.height)
        .map_err(|e| e.to_string())
}

pub fn clear(app: &tauri::AppHandle) {
    app.state::<Browser>()
        .document
        .fetch_add(1, Ordering::SeqCst);
    app.state::<Browser>().visibility.store(0, Ordering::SeqCst);
    let app = app.clone();
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        let _ = close_all(&app);
    });
}

fn close_lease(
    app: &tauri::AppHandle,
    lease: &qi_desktop_supervisor::browser::Lease,
) -> Result<(), String> {
    let broker = app.state::<Browser>();
    if let Some(view) = app.get_webview(&lease.label) {
        let hidden = view.hide();
        let closed = view.close();
        if hidden.is_err() || closed.is_err() {
            broker.uncertain.store(true, Ordering::SeqCst);
            return Err(
                "browser cleanup UNKNOWN; use Clean all browser tabs or exit normally".into(),
            );
        }
    }
    broker
        .leases
        .lock()
        .unwrap()
        .release(&lease.id, &lease.workspace, lease.generation)
        .map_err(|e| e.to_string())?;
    broker.navigation.lock().unwrap().remove(&lease.id);
    broker.completed.lock().unwrap().remove(&lease.id);
    if broker.leases.lock().unwrap().is_empty() {
        broker.uncertain.store(false, Ordering::SeqCst);
    }
    Ok(())
}

fn close_all(app: &tauri::AppHandle) -> Result<(), String> {
    let broker = app.state::<Browser>();
    let snapshot = broker.leases.lock().unwrap().snapshot();
    let mut failed = false;
    for lease in snapshot {
        if close_lease(app, &lease).is_err() {
            failed = true;
        }
    }
    if failed {
        return Err("browser cleanup UNKNOWN; exit the app normally before retrying".into());
    }
    broker.leases.lock().unwrap().clear_ledger_if_empty();
    clear_stores();
    Ok(())
}

/// Explicit override of Wry's automatic reload-on-crash default. Never replay a
/// disconnected page; keep its identity until a confirmed native close.
pub fn disconnected(view: &tauri::Webview) {
    let app = view.app_handle();
    let broker = app.state::<Browser>();
    let item = broker
        .leases
        .lock()
        .unwrap()
        .snapshot()
        .into_iter()
        .find(|item| item.label == view.label());
    if let Some(item) = item {
        if let Some((revision, unknown)) = broker.navigation.lock().unwrap().get_mut(&item.id) {
            *revision += 1;
            *unknown = true;
        }
        if view.hide().is_err() {
            broker.uncertain.store(true, Ordering::SeqCst);
        }
        let revision = broker
            .navigation
            .lock()
            .unwrap()
            .get(&item.id)
            .map(|v| v.0)
            .unwrap_or(0);
        update(
            app,
            &item.id,
            json!({"revision":revision,"unknown":true,"loading":false,"error":"网页进程失联；请先关闭标签，再选择恢复。未自动重载。"}),
        );
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_foundation::{NSError, NSString, NSURL};
    use objc2_web_kit::{
        WKContentRuleList, WKContentRuleListStore, WKWebView, WKWebViewConfiguration,
        WKWebsiteDataStore,
    };
    use std::{cell::RefCell, collections::BTreeMap};
    thread_local! {static STORES:RefCell<BTreeMap<String,Retained<WKWebsiteDataStore>>>=RefCell::new(BTreeMap::new());}

    pub fn clear_stores() {
        STORES.with(|stores| stores.borrow_mut().clear());
    }
    pub fn history(view: &tauri::Webview, back: bool) -> Result<(), String> {
        view.with_webview(move |platform| unsafe {
            let native = &*(platform.inner() as *const WKWebView);
            if back {
                native.goBack();
            } else {
                native.goForward();
            }
        })
        .map_err(|e| e.to_string())
    }

    // Sample current native state rather than applying a possibly stale load
    // event payload to a later navigation (including repeated identical URLs).
    pub fn observe(app: tauri::AppHandle, id: String, request: Option<String>) {
        sample(app, id, request, None);
    }
    fn sample(
        app: tauri::AppHandle,
        id: String,
        request: Option<String>,
        finished_url: Option<String>,
    ) {
        let lease = app
            .state::<Browser>()
            .leases
            .lock()
            .unwrap()
            .snapshot()
            .into_iter()
            .find(|lease| lease.id == id);
        let Some(lease) = lease else {
            return;
        };
        let Some(view) = app.get_webview(&lease.label) else {
            return;
        };
        let callback_app = app.clone();
        if view.with_webview(move |platform| unsafe {
            let broker = callback_app.state::<Browser>();
            let Some((revision, unknown)) = broker.navigation.lock().unwrap().get(&id).copied() else { return; };
            let native = &*(platform.inner() as *const WKWebView);
            let url = native.URL().and_then(|url|url.absoluteString()).map(|value|value.to_string()).unwrap_or_default();
            if finished_url.as_deref() == Some(url.as_str()) && !native.isLoading() {
                broker.completed.lock().unwrap().insert(id.clone(),revision);
            }
            let confirmed = broker.completed.lock().unwrap().get(&id) == Some(&revision);
            let state = json!({"lease":id,"revision":revision,"unknown":unknown,
                "url":if url=="about:blank"{String::new()}else{url},"confirmed":confirmed,
                "title":native.title().map(|value|value.to_string().chars().take(256).collect::<String>()).unwrap_or_default(),
                "loading":native.isLoading(),"canBack":native.canGoBack(),"canForward":native.canGoForward()});
            update(&callback_app,&id,state.clone());
            if let Some(request) = request { reply(&callback_app,&request,Ok(state)); }
        }).is_err() {
            // Never synthesize a successful observation when the native queue
            // is unavailable. The owner retains the unconfirmed request.
            app.state::<Browser>().uncertain.store(true,Ordering::SeqCst);
        }
    }

    pub fn create_guest(
        app: tauri::AppHandle,
        request_id: String,
        lease: qi_desktop_supervisor::browser::Lease,
        _bounds: Bounds,
        url: Option<tauri::Url>,
        origin: String,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("browser creation must run on main thread")?;
        let store = STORES.with(|stores| {
            let mut stores = stores.borrow_mut();
            if let Some(store) = stores.get(&lease.workspace) {
                return Ok(store.clone());
            }
            if stores.len() >= 32 {
                return Err("browser workspace storage limit reached".to_string());
            }
            let store = unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) };
            stores.insert(lease.workspace.clone(), store.clone());
            Ok(store)
        })?;
        let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
        unsafe {
            configuration.setWebsiteDataStore(&store);
        }
        // All requests to the private Host port are blocked, including frame,
        // fetch and websocket traffic through DNS aliases. No Host Cookie or
        // native permission is shared with this nonpersistent workspace store.
        let host = tauri::Url::parse(&origin).map_err(|e| e.to_string())?;
        let port = host.port().ok_or("missing Host port")?;
        let rules = json!([
            {"trigger":{"url-filter":format!("^[a-z]+://[^/]+:{port}([/?#]|$)")},"action":{"type":"block"}},
            {"trigger":{"url-filter":"^(file|tauri|ipc|asset|qi-browser):"},"action":{"type":"block"}}
        ]);
        let shell = app.state::<std::sync::Arc<super::super::Shell>>();
        let rule_root = shell.state.join("browser-rules");
        qi_desktop_supervisor::private_directory(&rule_root).map_err(|e| e.to_string())?;
        let store_url = NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&rule_root.to_string_lossy()),
            true,
        );
        let rule_store = unsafe { WKContentRuleListStore::storeWithURL(Some(&store_url), mtm) }
            .ok_or("browser filter store unavailable")?;
        let rule_name = NSString::from_str(&format!("qi-host-{port}"));
        let encoded = NSString::from_str(&rules.to_string());
        let created = std::time::Instant::now();
        let completion = RcBlock::new(move |rule: *mut WKContentRuleList, error: *mut NSError| {
            let Some(_mtm) = MainThreadMarker::new() else {
                acquire_failed(
                    &app,
                    &request_id,
                    &lease,
                    "browser filter completed off main thread",
                );
                return;
            };
            if !error.is_null() || rule.is_null() {
                acquire_failed(
                    &app,
                    &request_id,
                    &lease,
                    "browser isolation filter failed; no page opened",
                );
                return;
            }
            let state = app.state::<std::sync::Arc<super::super::Shell>>();
            if created.elapsed() > std::time::Duration::from_secs(8)
                || app
                    .state::<Browser>()
                    .leases
                    .lock()
                    .unwrap()
                    .get(&lease.id, &lease.workspace, lease.generation)
                    .is_err()
                || state.generation.load(std::sync::atomic::Ordering::SeqCst) != lease.generation
                || state.origin.read().unwrap().as_deref() != Some(origin.as_str())
            {
                acquire_failed(
                    &app,
                    &request_id,
                    &lease,
                    "browser request expired or belongs to an old runtime",
                );
                return;
            }
            unsafe {
                configuration
                    .userContentController()
                    .addContentRuleList(&*rule);
            }
            let id = lease.id.clone();
            let label = lease.label.clone();
            let generation = lease.generation;
            let navigation_app = app.clone();
            let event_app = app.clone();
            let title_app = app.clone();
            let navigation_id = id.clone();
            let event_id = id.clone();
            let title_id = id.clone();
            let popup_app = app.clone();
            let popup_id = id.clone();
            let popup_origin = origin.clone();
            let blocked_origin = origin.clone();
            let navigation_workspace = lease.workspace.clone();
            let builder =
                WebviewBuilder::new(&label, WebviewUrl::External("about:blank".parse().unwrap()))
                    .with_webview_configuration(configuration.clone())
                    .devtools(false)
                    .on_permission_request(|_, _| PermissionResponse::Deny)
                    .on_download(|_, _| false)
                    .on_new_window(move |url, _| {
                        if target(url.as_str(), &popup_origin).is_ok() {
                            update(&popup_app, &popup_id, json!({"popup":url.to_string()}));
                        }
                        NewWindowResponse::Deny
                    })
                    .on_navigation(move |target_url| {
                        let state = navigation_app.state::<std::sync::Arc<super::super::Shell>>();
                        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                            || navigation_app
                                .state::<Browser>()
                                .leases
                                .lock()
                                .unwrap()
                                .get(&navigation_id, &navigation_workspace, generation)
                                .is_err()
                        {
                            return false;
                        }
                        if target_url.as_str() == "about:blank" {
                            return true;
                        }
                        let allowed = target(target_url.as_str(), &blocked_origin).is_ok();
                        if allowed {
                            if let Some((revision, _)) = navigation_app
                                .state::<Browser>()
                                .navigation
                                .lock()
                                .unwrap()
                                .get_mut(&navigation_id)
                            {
                                *revision += 1;
                            }
                        }
                        if !allowed {
                            update(
                                &navigation_app,
                                &navigation_id,
                                json!({"error":"此地址不能在隔离浏览器中打开"}),
                            );
                        }
                        allowed
                    })
                    .on_page_load(move |_, payload| {
                        sample(
                            event_app.clone(),
                            event_id.clone(),
                            None,
                            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                                Some(payload.url().to_string())
                            } else {
                                None
                            },
                        )
                    })
                    .on_document_title_changed(move |_, _| {
                        observe(title_app.clone(), title_id.clone(), None)
                    });
            let result = app
                .get_window("main")
                .ok_or("main window unavailable")
                .and_then(|window| {
                    window
                        .add_child(
                            builder,
                            tauri::LogicalPosition::new(0.0, 0.0),
                            tauri::LogicalSize::new(1.0, 1.0),
                        )
                        .map_err(|_| "browser guest could not be created")
                });
            match result {
                Ok(view) => {
                    // A lease starts hidden. Only a current owner bounds/show
                    // request may present it; late acquisition cannot cover a
                    // different session, closed panel, or approval dialog.
                    if view.hide().is_err() {
                        acquire_failed(
                            &app,
                            &request_id,
                            &lease,
                            "browser visibility not confirmed",
                        );
                        return;
                    }
                    if let Some(url) = url.clone() {
                        if view.navigate(url).is_err() {
                            acquire_failed(&app, &request_id, &lease, "browser navigation failed");
                            return;
                        }
                    }
                    reply(
                        &app,
                        &request_id,
                        Ok(
                            json!({"lease":lease.id,"url":url.as_ref().map(|u|u.as_str()),"storage":"workspace-memory","native":true,"revision":0}),
                        ),
                    );
                }
                Err(error) => acquire_failed(&app, &request_id, &lease, error),
            }
        });
        unsafe {
            rule_store
                .compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                    Some(&rule_name),
                    Some(&encoded),
                    Some(&completion),
                );
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
use mac::{clear_stores, create_guest, history, observe};
