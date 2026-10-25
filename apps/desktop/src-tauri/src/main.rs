#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod browser;
use qi_desktop_supervisor::acceptance::Acceptance;
use qi_desktop_supervisor::{Supervisor, external_link, lock_installation};
use std::{
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::NewWindowResponse,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
static NEXT_PREVIEW: AtomicU64 = AtomicU64::new(1);

struct Shell {
    supervisor: Mutex<Supervisor>,
    origin: RwLock<Option<String>>,
    generation: AtomicU64,
    changing: AtomicBool,
    quitting: AtomicBool,
    exit_ready: AtomicBool,
    picking: AtomicBool,
    restart_prompt: AtomicBool,
    link_prompt: AtomicBool,
    payload: PathBuf,
    state: PathBuf,
    acceptance: Option<Arc<Acceptance>>,
    _lease: File,
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn notice(app: &tauri::AppHandle, message: impl Into<String>) {
    app.dialog().message(message).title("qì agent").show(|_| {});
}

fn failed(app: &tauri::AppHandle, message: &str) {
    if let Some(mode) = &app.state::<Arc<Shell>>().acceptance {
        let _ = mode.record("startup_failed");
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let mut url = tauri::Url::parse("tauri://localhost/index.html").expect("constant URL");
        url.query_pairs_mut().append_pair("status", message);
        let _ = window.navigate(url);
    }
    notice(app, message);
}

fn start(app: tauri::AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.quitting.load(Ordering::SeqCst) || shell.changing.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = shell.generation.fetch_add(1, Ordering::SeqCst) + 1;
    browser::clear(&app);
    *shell.origin.write().unwrap() = None;
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.close();
        }
    }
    thread::spawn(move || {
        let result = shell
            .supervisor
            .lock()
            .unwrap()
            .launch(&shell.payload, &shell.state);
        if shell.generation.load(Ordering::SeqCst) == generation {
            match result {
                Ok(ready) => {
                    if let Some(mode) = &shell.acceptance {
                        let _ = mode.record("host_authenticated_ready");
                    }
                    *shell.origin.write().unwrap() = Some(ready.origin());
                    if let (Some(window), Ok(url)) =
                        (app.get_webview_window("main"), ready.bootstrap_url())
                    {
                        let _ = window.navigate(url);
                    }
                }
                Err(error) => failed(
                    &app,
                    &format!(
                        "本地服务未就绪：{error}。未确认的任务不会自动重放；可从菜单重试或退出。"
                    ),
                ),
            }
        }
        shell.changing.store(false, Ordering::SeqCst);
    });
}

fn quit(app: tauri::AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    app.dialog()
        .message("退出会停止本应用的会话、工具和本地服务。尚未提交的草稿不会发送。")
        .title("退出 qì agent？")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "退出".into(),
            "返回".into(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                shell.quitting.store(false, Ordering::SeqCst);
                return;
            }
            shell.generation.fetch_add(1, Ordering::SeqCst);
            browser::clear(&app);
            *shell.origin.write().unwrap() = None;
            let handle = app.clone();
            thread::spawn(move || match shell.supervisor.lock().unwrap().stop() {
                Ok(()) => {
                    shell.exit_ready.store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                Err(error) => {
                    shell.quitting.store(false, Ordering::SeqCst);
                    failed(
                        &handle,
                        &format!("尚未确认子进程清理：{error}。保留原状态并阻止启动新的服务。"),
                    );
                }
            });
        });
}

fn folder(app: tauri::AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.acceptance.is_some() {
        return;
    }
    if shell.changing.load(Ordering::SeqCst)
        || shell.quitting.load(Ordering::SeqCst)
        || shell.origin.read().unwrap().is_none()
        || shell.picking.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let generation = shell.generation.load(Ordering::SeqCst);
    show(&app);
    app.dialog().file().set_title("选择项目（不会自动信任）").pick_folder(move |path| {
        shell.picking.store(false, Ordering::SeqCst);
        if shell.generation.load(Ordering::SeqCst) != generation || shell.quitting.load(Ordering::SeqCst) { return; }
        let Some(path) = path.and_then(|value| value.into_path().ok()) else { return; };
        // Prefill the existing Web dialog only. Its explicit confirmation,
        // allowlist, trust prompt, approvals and command journals remain intact.
        if let Some(window) = app.get_webview_window("main") {
            let detail = serde_json::to_string(&path.to_string_lossy()).unwrap();
            let script = format!("window.dispatchEvent(new CustomEvent('qi-desktop-directory', {{detail:{detail}}}));");
            let _ = window.eval(script);
        }
    });
}

fn external(app: tauri::AppHandle, raw: String) {
    let Ok(url) = external_link(&raw) else {
        return;
    };
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.acceptance.is_some() {
        return;
    }
    if shell.quitting.load(Ordering::SeqCst) || shell.link_prompt.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = shell.generation.load(Ordering::SeqCst);
    app.dialog()
        .message(format!("在系统应用中打开以下链接？\n{url}"))
        .title("打开外部链接")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "打开".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            shell.link_prompt.store(false, Ordering::SeqCst);
            if confirmed
                && shell.generation.load(Ordering::SeqCst) == generation
                && !shell.quitting.load(Ordering::SeqCst)
            {
                if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                    notice(&app, format!("无法打开链接：{error}"));
                }
            }
        });
}

fn main() {
    // A test mode narrows runtime data and external actions; it never changes
    // the executor's sandbox or grants permission to a tool/project/site.
    let acceptance = match (
        std::env::var_os("QI_DESKTOP_ACCEPTANCE_ROOT"),
        std::env::var("QI_DESKTOP_ACCEPTANCE_ID"),
    ) {
        (None, Err(_)) => None,
        (Some(root), Ok(id)) => match Acceptance::load(&PathBuf::from(root), &id) {
            Ok(mode) => Some(Arc::new(mode)),
            Err(_) => {
                eprintln!("Invalid desktop acceptance plan; no services started");
                std::process::exit(2);
            }
        },
        _ => {
            eprintln!("Incomplete desktop acceptance plan; no services started");
            std::process::exit(2);
        }
    };
    let mut context = tauri::generate_context!();
    if let Some(mode) = &acceptance {
        context.config_mut().identifier = mode.identifier();
    }
    let app = tauri::Builder::default()
        .on_web_content_process_terminate(|view| {
            if view.label() == "main" {
                if let Some(mode) = &view.app_handle().state::<Arc<Shell>>().acceptance {
                    mode.mark_failed();
                }
                browser::clear(view.app_handle());
                if let Some(mode) = &view.app_handle().state::<Arc<Shell>>().acceptance {
                    let _ = mode.record("startup_failed");
                } else {
                    notice(
                        view.app_handle(),
                        "应用页面进程失联，未自动重载。请从应用菜单明确重启本地服务或正常退出。",
                    );
                }
            } else {
                browser::disconnected(view);
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        // Native confirmation below owns link opening. Do not inject the
        // plugin's renderer click handler (the renderer has no opener IPC).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // Intentionally no invoke_handler and no remote capability grants.
        .setup(move |app| {
            let state = if let Some(mode) = &acceptance {
                mode.state_directory()
            } else {
                app.path().app_data_dir()?
            };
            let lease = lock_installation(&state)?;
            let payload = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../stage/runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            if let Some(mode) = &acceptance {
                let manifest: serde_json::Value =
                    serde_json::from_reader(File::open(payload.join("runtime-manifest.json"))?)?;
                if manifest["source_sha"] != mode.plan.source_sha {
                    return Err("acceptance source revision mismatch".into());
                }
            }
            let shell = Arc::new(Shell {
                supervisor: Mutex::new(Supervisor::default()),
                origin: RwLock::new(None),
                generation: AtomicU64::new(0),
                changing: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                exit_ready: AtomicBool::new(false),
                picking: AtomicBool::new(false),
                restart_prompt: AtomicBool::new(false),
                link_prompt: AtomicBool::new(false),
                payload,
                state,
                acceptance: acceptance.clone(),
                _lease: lease,
            });
            // Native prompts are merged independently from service transitions.
            app.manage(shell.clone());
            app.manage(browser::Browser::default());
            let navigation_app = app.handle().clone();
            let navigation_shell = shell.clone();
            let new_window_app = app.handle().clone();
            let page_shell = shell.clone();
            let page_app = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            // Keep the same persistent WebKit behavior as normal launches,
            // isolated in a verifier-owned store shared only by its two phases.
            let window = if let Some(mode) = &acceptance {
                window.data_store_identifier(mode.data_store_identifier())
            } else {
                window
            };
            window
                .initialization_script(
                    "Object.defineProperty(window,'__QI_DESKTOP_BROWSER__',{value:true});",
                )
                .title("qì agent")
                .inner_size(1280.0, 840.0)
                .min_inner_size(360.0, 480.0)
                .on_page_load(move |_, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Started {
                        browser::clear(&page_app);
                    }
                    if payload.event() == tauri::webview::PageLoadEvent::Finished
                        && page_shell.origin.read().unwrap().as_deref()
                            == Some(payload.url().origin().ascii_serialization().as_str())
                    {
                        if let Some(mode) = &page_shell.acceptance {
                            let _ = mode.record("web_document_loaded");
                        }
                    }
                })
                .on_navigation(move |url| {
                    if browser::intercept(&navigation_app, url) {
                        return false;
                    }
                    if url.scheme() == "tauri"
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                    {
                        return true;
                    }
                    let allowed = navigation_shell.origin.read().unwrap().clone();
                    if allowed.as_deref() == Some(url.origin().ascii_serialization().as_str()) {
                        return true;
                    }
                    external(navigation_app.clone(), url.to_string());
                    false
                })
                .on_new_window(move |url, features| {
                    let shell = new_window_app.state::<Arc<Shell>>().inner().clone();
                    if shell.acceptance.is_some() {
                        return NewWindowResponse::Deny;
                    }
                    let origin = shell.origin.read().unwrap().clone();
                    if origin.as_deref() == Some(url.origin().ascii_serialization().as_str()) {
                        if new_window_app.webview_windows().len() >= 6 {
                            notice(&new_window_app, "请先关闭已有文件预览窗口。");
                            return NewWindowResponse::Deny;
                        }
                        let generation = shell.generation.load(Ordering::SeqCst);
                        let label =
                            format!("preview-{}", NEXT_PREVIEW.fetch_add(1, Ordering::SeqCst));
                        // Share WebKit's caller configuration/cookies, but no
                        // native capability. This is not a browser/tool lease.
                        let result = WebviewWindowBuilder::new(
                            &new_window_app,
                            label,
                            WebviewUrl::External("about:blank".parse().unwrap()),
                        )
                        .window_features(features)
                        .title("qì agent · 文件预览")
                        .inner_size(900.0, 700.0)
                        .on_navigation(move |target| {
                            if target.as_str() == "about:blank" {
                                return true;
                            }
                            shell.generation.load(Ordering::SeqCst) == generation
                                && shell.origin.read().unwrap().as_deref()
                                    == Some(target.origin().ascii_serialization().as_str())
                        })
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .build();
                        return match result {
                            Ok(window) => NewWindowResponse::Create { window },
                            Err(_) => {
                                notice(
                                    &new_window_app,
                                    "无法打开文件预览，请使用会话中的文件面板。",
                                );
                                NewWindowResponse::Deny
                            }
                        };
                    }
                    external(new_window_app.clone(), url.to_string());
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Some(mode) = &acceptance {
                mode.record("window_created")?;
                let mode = mode.clone();
                let handle = app.handle().clone();
                let acceptance_shell = shell.clone();
                thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(45);
                    while Instant::now() < deadline {
                        if mode.page_ready() {
                            break;
                        }
                        if let Some(window) = handle.get_webview_window("main") {
                            let expected = acceptance_shell.origin.read().unwrap().clone();
                            let current = window.url().ok();
                            if expected.is_some()
                                && current.as_ref().is_some_and(|url| {
                                    expected.as_deref()
                                        == Some(url.origin().ascii_serialization().as_str())
                                        && url.path() == "/"
                                        && url.query().is_none()
                                })
                            {
                                let (send, receive) = std::sync::mpsc::channel();
                                let evaluation = window.eval_with_callback(
                                    include_str!("acceptance_probe.js"),
                                    move |value| {
                                        let _ = send.send(value);
                                    },
                                );
                                let remaining = deadline.saturating_duration_since(Instant::now());
                                let observed = if evaluation.is_ok() {
                                    receive
                                        .recv_timeout(remaining.min(Duration::from_secs(2)))
                                        .ok()
                                } else {
                                    None
                                };
                                match observed
                                    .as_deref()
                                    .map(|value| mode.observe_auth_probe(value))
                                {
                                    Some(Ok(true)) => break,
                                    Some(Ok(false)) => {}
                                    _ => {
                                        let _ = mode.record("startup_failed");
                                        break;
                                    }
                                }
                            }
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    if mode.finishing.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    acceptance_shell.quitting.store(true, Ordering::SeqCst);
                    acceptance_shell.generation.fetch_add(1, Ordering::SeqCst);
                    *acceptance_shell.origin.write().unwrap() = None;
                    let mut supervisor = acceptance_shell.supervisor.lock().unwrap();
                    if !supervisor.alive() {
                        mode.mark_failed();
                    }
                    let cleaned = supervisor.stop().is_ok();
                    drop(supervisor);
                    let passed = mode.finish(cleaned).unwrap_or(false);
                    acceptance_shell.exit_ready.store(true, Ordering::SeqCst);
                    handle.exit(if passed { 0 } else { 1 });
                });
            }
            let open = MenuItem::with_id(app, "project", "打开项目…", true, Some("CmdOrCtrl+O"))?;
            let restart = MenuItem::with_id(app, "restart", "重启本地服务…", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "退出 qì agent…", true, Some("CmdOrCtrl+Q"))?;
            let app_menu = Submenu::with_items(
                app,
                "qì agent",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("关于 qì agent"), None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some("隐藏 qì agent"))?,
                    &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                    &PredefinedMenuItem::show_all(app, Some("显示全部"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &exit,
                ],
            )?;
            let file = Submenu::with_items(app, "文件", true, &[&open, &restart])?;
            let new_browser = MenuItem::with_id(
                app,
                "browser-new",
                "新建浏览器标签",
                acceptance.is_none(),
                Some("CmdOrCtrl+T"),
            )?;
            let close_browser = MenuItem::with_id(
                app,
                "browser-close",
                "关闭浏览器标签",
                acceptance.is_none(),
                Some("CmdOrCtrl+W"),
            )?;
            let browser_menu =
                Submenu::with_items(app, "浏览器", true, &[&new_browser, &close_browser])?;
            let edit = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(
                app,
                &[&app_menu, &file, &edit, &browser_menu],
            )?)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "project" => folder(app.clone()),
                "quit" => quit(app.clone()),
                "browser-new" | "browser-close" => {
                    let shell = app.state::<Arc<Shell>>();
                    if shell.acceptance.is_some()
                        || shell.quitting.load(Ordering::SeqCst)
                        || shell.origin.read().unwrap().is_none()
                    {
                        return;
                    }
                    if let Some(main) = app.get_webview_window("main") {
                        let event = if event.id().as_ref() == "browser-new" {
                            "qi-browser-new-tab"
                        } else {
                            "qi-browser-close-tab"
                        };
                        let _ = main.eval(format!("window.dispatchEvent(new Event('{event}'));"));
                    }
                }
                "restart" => {
                    let shell = app.state::<Arc<Shell>>().inner().clone();
                    if shell.acceptance.is_some() {
                        return;
                    }
                    if shell.changing.load(Ordering::SeqCst)
                        || shell.quitting.load(Ordering::SeqCst)
                        || shell.restart_prompt.swap(true, Ordering::SeqCst)
                    {
                        return;
                    }
                    let generation = shell.generation.load(Ordering::SeqCst);
                    let app = app.clone();
                    app.clone()
                        .dialog()
                        .message(
                            "重启会停止本应用的任务。未确认的输入不会重放；未提交草稿可能丢失。",
                        )
                        .title("重启本地服务？")
                        .buttons(MessageDialogButtons::OkCancel)
                        .show(move |yes| {
                            shell.restart_prompt.store(false, Ordering::SeqCst);
                            if yes
                                && shell.generation.load(Ordering::SeqCst) == generation
                                && !shell.quitting.load(Ordering::SeqCst)
                            {
                                start(app);
                            }
                        });
                }
                _ => {}
            });
            let monitor = app.handle().clone();
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(2));
                    let shell = monitor.state::<Arc<Shell>>().inner().clone();
                    if shell.changing.load(Ordering::SeqCst)
                        || shell.quitting.load(Ordering::SeqCst)
                    {
                        continue;
                    }
                    let mut supervisor = shell.supervisor.lock().unwrap();
                    if shell.origin.read().unwrap().is_some()
                        && supervisor.has_runtime()
                        && !supervisor.alive()
                    {
                        if let Some(mode) = &shell.acceptance {
                            mode.mark_failed();
                        }
                        shell.generation.fetch_add(1, Ordering::SeqCst);
                        *shell.origin.write().unwrap() = None;
                        let result = supervisor.stop();
                        drop(supervisor);
                        failed(
                            &monitor,
                            if result.is_ok() {
                                "本地服务已退出。请从菜单重试；任务不会自动重放。"
                            } else {
                                "本地服务退出，子进程清理尚未确认。保留状态并阻止新的服务启动。"
                            },
                        );
                    }
                }
            });
            start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if cfg!(target_os = "macos") {
                    let _ = window.hide();
                } else {
                    quit(window.app_handle().clone());
                }
            }
        })
        .build(context)
        .expect("could not initialize qì agent desktop");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let shell = app.state::<Arc<Shell>>();
            if !shell.exit_ready.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app.clone());
            }
        }
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
