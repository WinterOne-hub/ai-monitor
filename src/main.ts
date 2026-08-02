import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import OverlayApp from "./views/OverlayApp.vue";
import DashboardApp from "./views/DashboardApp.vue";
import "./styles.css";

// 根据窗口 label 渲染不同视图：
//   overlay  -> 悬浮卡片（常驻小角落）
//   dashboard -> 完整面板
const label = getCurrentWindow().label;
const rootComponent = label === "overlay" ? OverlayApp : DashboardApp;

createApp(rootComponent).mount("#app");
