// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod proxy;
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

            // 启动统一代理（本地 HTTP，自动记录 token 用量）
            proxy::start(app.handle().clone());

            let handle = app.handle().clone();
            let handle2 = app.handle().clone();

            // 关闭窗口 = 隐藏到托盘，进程常驻
            // dashboard 关闭 -> 隐藏 + 回归灵动岛
            if let Some(w) = app.get_webview_window("dashboard") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                        // 面板隐藏后回归灵动岛
                        if let Some(ov) = handle.get_webview_window("overlay") {
                            let _ = ov.show();
                        }
                    }
                });
            }
            if let Some(w) = app.get_webview_window("overlay") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                        // 岛隐藏时面板也进托盘
                        if let Some(d) = handle2.get_webview_window("dashboard") {
                            let _ = d.hide();
                        }
                    }
                });
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
            commands::http_get_text,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
