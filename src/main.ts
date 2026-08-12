import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { register } from "@tauri-apps/plugin-global-shortcut";
import OverlayApp from "./views/OverlayApp.vue";
import DashboardApp from "./views/DashboardApp.vue";
import { i18n } from "./i18n";
import "./styles.css";

// 根据窗口 label 渲染不同视图：
//   overlay  -> 悬浮卡片（常驻小角落）
//   dashboard -> 完整面板
const label = getCurrentWindow().label;
const rootComponent = label === "overlay" ? OverlayApp : DashboardApp;

// 全局快捷键（仅面板窗口注册一次，窗口在后台常驻不会销毁）
// ⌥Space 在 macOS 上会抢占输入法切换，故改用 ⌘⇧Space / ⌘⇧O
if (label === "dashboard") {
  const win = getCurrentWindow();
  void (async () => {
    // ⌘⇧Space：呼出面板（隐藏岛）/ 隐藏面板（回归岛），保持二者互斥
    await register("Command+Shift+Space", (event) => {
      if (event.state === "Pressed") {
        void (async () => {
          const visible = await win.isVisible().catch(() => false);
          if (visible) {
            await invoke("hide_window", { label: "dashboard" });
            await invoke("show_window", { label: "overlay" });
          } else {
            await invoke("hide_window", { label: "overlay" });
            await invoke("show_window", { label: "dashboard" });
          }
        })();
      }
    }).catch((e) => console.error("[shortcut] Command+Shift+Space 注册失败", e));
    // ⌘⇧O：显示灵动岛（隐藏面板）/ 隐藏灵动岛
    await register("Command+Shift+O", (event) => {
      if (event.state === "Pressed") {
        void (async () => {
          const ovVisible = await WebviewWindow.getByLabel("overlay")
            .then((w) => (w ? w.isVisible() : Promise.resolve(true)))
            .catch(() => true);
          if (ovVisible) {
            await invoke("hide_window", { label: "overlay" });
          } else {
            await invoke("hide_window", { label: "dashboard" });
            await invoke("show_window", { label: "overlay" });
          }
        })();
      }
    }).catch((e) => console.error("[shortcut] Command+Shift+O 注册失败", e));
  })();
}

createApp(rootComponent).use(i18n).mount("#app");
