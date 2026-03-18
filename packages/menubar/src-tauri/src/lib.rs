use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
struct WidgetPosition {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct WidgetSettings {
    show_widget: bool,
    #[serde(default)]
    has_seen_tooltip: bool,
    #[serde(default)]
    onboarding_v1_completed: bool,
}

fn position_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".hexdeck").join("widget-position.json"))
}

fn settings_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".hexdeck").join("menubar-settings.json"))
}

fn load_widget_visibility() -> bool {
    let Some(path) = settings_file() else {
        return true;
    };
    let Ok(data) = fs::read_to_string(path) else {
        return true;
    };
    let Ok(settings) = serde_json::from_str::<WidgetSettings>(&data) else {
        return true;
    };
    settings.show_widget
}

fn load_settings() -> WidgetSettings {
    let Some(path) = settings_file() else {
        return WidgetSettings { show_widget: true, has_seen_tooltip: false, onboarding_v1_completed: false };
    };
    let Ok(data) = fs::read_to_string(path) else {
        return WidgetSettings { show_widget: true, has_seen_tooltip: false, onboarding_v1_completed: false };
    };
    serde_json::from_str(&data).unwrap_or(WidgetSettings { show_widget: true, has_seen_tooltip: false, onboarding_v1_completed: false })
}

fn save_settings(settings: &WidgetSettings) -> Result<(), String> {
    let path = settings_file().ok_or("Cannot resolve home directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn save_widget_visibility(show_widget: bool) -> Result<(), String> {
    let mut settings = load_settings();
    settings.show_widget = show_widget;
    save_settings(&settings)
}

fn apply_widget_visibility(app: &tauri::AppHandle, show_widget: bool) {
    if let Some(widget) = app.get_webview_window("widget") {
        if show_widget {
            let _ = widget.show();
            let _ = widget.set_focus();
        } else {
            let _ = widget.hide();
        }
    }
}

// ─── Server Lifecycle ──────────────────────────────────────────────────────

const SERVER_PORT: u16 = 7433;

#[derive(Deserialize)]
struct PidInfo {
    pid: u64,
    #[allow(dead_code)]
    port: u16,
}

fn hexdeck_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".hexdeck"))
}

fn is_server_reachable() -> bool {
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], SERVER_PORT)),
        Duration::from_secs(2),
    )
    .is_ok()
}

fn load_pid_info() -> Option<PidInfo> {
    let path = hexdeck_dir()?.join("server.pid");
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn is_pid_running(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn spawn_server(app: &tauri::AppHandle) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {e}"))?;

    let binary = resource_dir.join("hexdeck-server");
    if !binary.exists() {
        return Err(format!("Server binary not found at {}", binary.display()));
    }

    // Ensure executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&binary, fs::Permissions::from_mode(0o755));
    }

    let dashboard_dir = resource_dir.join("dashboard");
    let mut cmd = std::process::Command::new(&binary);
    cmd.arg("--port").arg(SERVER_PORT.to_string());
    if dashboard_dir.exists() {
        cmd.arg("--dashboard-dir")
            .arg(dashboard_dir.to_string_lossy().as_ref());
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn server: {e}"))?;

    Ok(())
}

/// Kill the server process if we spawned it (reads PID from disk).
/// Falls back to killing by port if the PID file is missing/stale.
fn kill_server() {
    let mut killed_by_pid = false;

    if let Some(info) = load_pid_info() {
        if is_pid_running(info.pid) {
            unsafe { libc::kill(info.pid as i32, libc::SIGTERM); }
            // Wait up to 3s for graceful shutdown (removeHooks + cleanup)
            for _ in 0..30 {
                std::thread::sleep(Duration::from_millis(100));
                if !is_pid_running(info.pid) {
                    killed_by_pid = true;
                    break;
                }
            }
            // Escalate to SIGKILL if still alive
            if !killed_by_pid && is_pid_running(info.pid) {
                unsafe { libc::kill(info.pid as i32, libc::SIGKILL); }
                killed_by_pid = true;
            }
        }
    }

    // Fallback: find and kill any process listening on our port.
    // Handles cases where PID file is missing (crash, force-quit, dev mode).
    if !killed_by_pid {
        if let Ok(output) = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{}", SERVER_PORT)])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for line in pids.lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    unsafe { libc::kill(pid, libc::SIGTERM); }
                }
            }
        }
    }

    // Clean up PID file
    if let Some(dir) = hexdeck_dir() {
        let _ = fs::remove_file(dir.join("server.pid"));
    }
}

/// Tracks the epoch-seconds of the last spawn attempt.
/// Prevents rapid re-spawning but allows retry after SPAWN_COOLDOWN_SECS.
static LAST_SPAWN_ATTEMPT: AtomicU64 = AtomicU64::new(0);
const SPAWN_COOLDOWN_SECS: u64 = 30;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ensure_server_running(app: &tauri::AppHandle) {
    if is_server_reachable() {
        return;
    }

    // Clean stale PID
    if let Some(info) = load_pid_info() {
        if !is_pid_running(info.pid) {
            if let Some(dir) = hexdeck_dir() {
                let _ = fs::remove_file(dir.join("server.pid"));
            }
        } else {
            // PID running but port not reachable yet — wait a bit
            for _ in 0..10 {
                std::thread::sleep(Duration::from_millis(500));
                if is_server_reachable() {
                    return;
                }
            }
        }
    }

    // Rate-limit spawn attempts: skip if last attempt was < SPAWN_COOLDOWN_SECS ago
    let last = LAST_SPAWN_ATTEMPT.load(Ordering::SeqCst);
    let now = now_secs();
    if last > 0 && now.saturating_sub(last) < SPAWN_COOLDOWN_SECS {
        return;
    }
    LAST_SPAWN_ATTEMPT.store(now, Ordering::SeqCst);

    // Spawn and wait for it to become reachable
    if let Err(e) = spawn_server(app) {
        eprintln!("hexdeck: {e}");
        return;
    }

    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(500));
        if is_server_reachable() {
            return;
        }
    }
    eprintln!("hexdeck: server spawned but not reachable after 5s");
}

#[tauri::command]
fn ensure_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        ensure_server_running(&app);
    });
}

#[tauri::command]
fn update_tray_icon(app: tauri::AppHandle, color: String) -> Result<(), String> {
    let icon_bytes: &[u8] = match color.as_str() {
        "green" => include_bytes!("../icons/icon-green.png"),
        "yellow" => include_bytes!("../icons/icon-yellow.png"),
        "red" => include_bytes!("../icons/icon-red.png"),
        "blue" => include_bytes!("../icons/icon-blue.png"),
        _ => include_bytes!("../icons/icon-grey.png"),
    };

    let image = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn save_widget_position(x: f64, y: f64) -> Result<(), String> {
    let path = position_file().ok_or("Cannot resolve home directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&WidgetPosition { x, y }).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_widget_position() -> Option<WidgetPosition> {
    let path = position_file()?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[tauri::command]
fn load_has_seen_tooltip() -> bool {
    load_settings().has_seen_tooltip
}

#[tauri::command]
fn save_has_seen_tooltip() -> Result<(), String> {
    let mut settings = load_settings();
    settings.has_seen_tooltip = true;
    save_settings(&settings)
}

#[tauri::command]
fn load_has_completed_onboarding() -> bool {
    load_settings().onboarding_v1_completed
}

#[tauri::command]
fn save_has_completed_onboarding() -> Result<(), String> {
    let mut settings = load_settings();
    settings.onboarding_v1_completed = true;
    save_settings(&settings)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn toggle_main_window_from_tray(
    app: &tauri::AppHandle,
    tray: &tauri::tray::TrayIcon,
    tray_click_guard: &AtomicBool,
) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            tray_click_guard.store(true, Ordering::SeqCst);
            position_window_at_tray(&window, tray);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn toggle_main_window_from_shortcut(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Hide from dock on macOS
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            // Ensure the Hexdeck server is running (non-blocking)
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                ensure_server_running(&handle);
            });

            // Create tray icon
            let grey_icon = Image::from_bytes(include_bytes!("../icons/icon-grey.png"))
                .expect("Failed to load tray icon");

            // Shared flag to suppress focus-loss hide right after tray click
            let tray_click_guard: &'static AtomicBool =
                Box::leak(Box::new(AtomicBool::new(false)));
            let show_widget_flag: &'static AtomicBool =
                Box::leak(Box::new(AtomicBool::new(load_widget_visibility())));

            // Build right-click context menu
            let show_widget_item = CheckMenuItem::with_id(
                app,
                "toggle_widget",
                "Show Floating Widget  (Cmd+Ctrl+K)",
                true,
                show_widget_flag.load(Ordering::SeqCst),
                None::<&str>,
            )?;
            let shortcut_hint = MenuItem::with_id(
                app,
                "shortcut_hint",
                "Toggle Popup  (Cmd+Ctrl+H)",
                false,
                None::<&str>,
            )?;
            let open_dashboard = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_widget_item, &shortcut_hint, &open_dashboard, &quit])?;

            let guard_for_tray = tray_click_guard;
            let toggle_widget_menu_item = show_widget_item.clone();
            let widget_flag_for_menu = show_widget_flag;
            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(grey_icon)
                .icon_as_template(false)
                .tooltip("Hexdeck")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        toggle_main_window_from_tray(&app, tray, guard_for_tray);
                    }
                })
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "toggle_widget" => {
                            let next = !widget_flag_for_menu.load(Ordering::SeqCst);
                            widget_flag_for_menu.store(next, Ordering::SeqCst);
                            let _ = toggle_widget_menu_item.set_checked(next);
                            let _ = save_widget_visibility(next);
                            apply_widget_visibility(app, next);
                        }
                        "open_dashboard" => {
                            let _ = std::process::Command::new("open")
                                .arg("http://localhost:7433")
                                .spawn();
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Global shortcuts
            let shortcut_h = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::CONTROL),
                Code::KeyH,
            );
            let shortcut_k = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::CONTROL),
                Code::KeyK,
            );

            let widget_flag_for_shortcut = show_widget_flag;
            let toggle_widget_for_shortcut = show_widget_item.clone();

            app.global_shortcut().on_shortcuts(
                [shortcut_h, shortcut_k],
                move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.matches(
                        Modifiers::SUPER | Modifiers::CONTROL,
                        Code::KeyH,
                    ) {
                        toggle_main_window_from_shortcut(app);
                    } else if shortcut.matches(
                        Modifiers::SUPER | Modifiers::CONTROL,
                        Code::KeyK,
                    ) {
                        let next = !widget_flag_for_shortcut.load(Ordering::SeqCst);
                        widget_flag_for_shortcut.store(next, Ordering::SeqCst);
                        let _ = toggle_widget_for_shortcut.set_checked(next);
                        let _ = save_widget_visibility(next);
                        apply_widget_visibility(app, next);
                    }
                },
            )?;

            // Auto-hide main window on focus loss
            let guard_for_window = tray_click_guard;
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if *focused {
                            // Window just received focus — clear the guard
                            guard_for_window.store(false, Ordering::SeqCst);
                        } else {
                            // Window lost focus — hide unless we just opened via tray click
                            if guard_for_window.swap(false, Ordering::SeqCst) {
                                return; // suppress this one focus-loss
                            }
                            let _ = w.hide();
                        }
                    }
                });
            }

            // Show/hide widget based on persisted setting.
            // When shown, briefly focus to activate macOS mouse tracking.
            apply_widget_visibility(&app.handle().clone(), show_widget_flag.load(Ordering::SeqCst));

            // Show onboarding window on first launch
            if !load_settings().onboarding_v1_completed {
                if let Some(onboarding) = app.get_webview_window("onboarding") {
                    let _ = onboarding.show();
                    let _ = onboarding.set_focus();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update_tray_icon,
            save_widget_position,
            load_widget_position,
            load_has_seen_tooltip,
            save_has_seen_tooltip,
            load_has_completed_onboarding,
            save_has_completed_onboarding,
            quit_app,
            ensure_server
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_server();
            }
        });
}

fn position_window_at_tray(
    window: &tauri::WebviewWindow,
    tray: &tauri::tray::TrayIcon,
) {
    let Some(tray_rect) = tray.rect().ok().flatten() else {
        return;
    };

    // Extract physical coordinates from the Position/Size enums
    let (tray_x, tray_y) = match tray_rect.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(p) => (p.x, p.y),
    };
    let (tray_w, tray_h) = match tray_rect.size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(s) => (s.width, s.height),
    };

    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let window_width = window_size.width as f64;

    // Center window horizontally under the tray icon
    let x = tray_x + (tray_w / 2.0) - (window_width / 2.0);
    let y = tray_y + tray_h + 4.0;

    let _ = window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition {
            x: x as i32,
            y: y as i32,
        },
    ));
}
