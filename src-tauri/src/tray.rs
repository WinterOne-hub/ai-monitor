use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// 托盘动态状态（总余额、今日花费），由前端采集完成后通过 set_tray_status 更新
pub struct TrayStatus(pub Mutex<(String, String)>);

pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    app.manage(TrayStatus(Mutex::new((String::new(), String::new()))));

    let show_item = MenuItem::with_id(app, "show", "显示面板", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle_overlay", "显示/隐藏灵动岛", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &toggle_item, &quit_item])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::image::Image::new(&[], 0, 0));

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_dashboard(app),
            "toggle_overlay" => toggle_overlay(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_dashboard(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_dashboard(app: &AppHandle) {
    // 显示面板时隐藏灵动岛（二者互斥）
    if let Some(ov) = app.get_webview_window("overlay") {
        let _ = ov.hide();
    }
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

/// 更新托盘标题：macOS 在图标旁显示「¥余额 · -¥今日」
pub fn update_tray_status(app: &AppHandle, total: String, today: String) {
    if let Some(ts) = app.try_state::<TrayStatus>() {
        *ts.0.lock().unwrap_or_else(|e| e.into_inner()) = (total.clone(), today.clone());
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let label = if total.is_empty() && today.is_empty() {
            None
        } else {
            Some(format!("¥{total} · -¥{today}"))
        };
        let _ = tray.set_title(label);
    }
}