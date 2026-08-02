use keyring::Entry;
use tauri::Manager;

const KEYRING_SERVICE: &str = "ai-monitor";

fn keyring_entry(account: &str) -> Entry {
    Entry::new(KEYRING_SERVICE, account).expect("failed to create keyring entry")
}

/// 保存 API Key 到系统钥匙串（macOS Keychain / Windows DPAPI）
#[tauri::command]
pub fn save_secret(account: String, secret: String) -> Result<(), String> {
    keyring_entry(&account)
        .set_password(&secret)
        .map_err(|e| format!("保存密钥失败: {e}"))
}

/// 从系统钥匙串读取 API Key
#[tauri::command]
pub fn get_secret(account: String) -> Result<String, String> {
    keyring_entry(&account)
        .get_password()
        .map_err(|e| format!("读取密钥失败: {e}"))
}

/// 删除系统钥匙串中的 API Key
#[tauri::command]
pub fn delete_secret(account: String) -> Result<(), String> {
    keyring_entry(&account)
        .delete_credential()
        .map_err(|e| format!("删除密钥失败: {e}"))
}

/// 显示指定窗口
#[tauri::command]
pub fn show_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("window not found")?
        .show()
        .map_err(|e| e.to_string())
}

/// 隐藏指定窗口
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("window not found")?
        .hide()
        .map_err(|e| e.to_string())
}

/// 切换窗口显示/隐藏
#[tauri::command]
pub fn toggle_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        if w.is_visible().map_err(|e| e.to_string())? {
            w.hide().map_err(|e| e.to_string())?;
        } else {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 退出应用
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
