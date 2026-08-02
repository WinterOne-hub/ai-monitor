import { createApp } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import OverlayApp from "./views/OverlayApp.vue";
import DashboardApp from "./views/DashboardApp.vue";
import "./styles.css";

// 自检日志
void invoke("log_js", { msg: `boot label=${getCurrentWindow().label}` });

// 根据窗口 label 渲染不同视图：
//   overlay  -> 悬浮卡片（常驻小角落）
//   dashboard -> 完整面板
const label = getCurrentWindow().label;
const rootComponent = label === "overlay" ? OverlayApp : DashboardApp;

createApp(rootComponent).mount("#app");
