// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod tray;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:ai-monitor.db", vec![])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            tray::create_tray(app)?;

            // 启动诊断：打印窗口真实状态
            for label in ["dashboard", "overlay"] {
                if let Some(w) = app.get_webview_window(label) {
                    eprintln!(
                        "[window] {label}: visible={:?} pos={:?} size={:?}",
                        w.is_visible().unwrap_or(false),
                        w.outer_position().ok(),
                        w.outer_size().ok()
                    );
                } else {
                    eprintln!("[window] {label}: 未找到窗口");
                }
            }

            // 关闭窗口 = 隐藏到托盘，进程常驻
            for label in ["dashboard", "overlay"] {
                if let Some(w) = app.get_webview_window(label) {
                    let w2 = w.clone();
                    w.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = w2.hide();
                        }
                    });
                }
            }

            // 首次启动显示主面板（引导添加账户）；后续由托盘/悬浮卡控制
            if let Some(d) = app.get_webview_window("dashboard") {
                let _ = d.show();
                let _ = d.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::show_window,
            commands::hide_window,
            commands::toggle_window,
            commands::http_get_json,
            commands::http_post_json,
            commands::quit_app,
            commands::log_js,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
