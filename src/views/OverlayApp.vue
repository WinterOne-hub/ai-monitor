<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import {
  initDb,
  listAccounts,
  latestBalances,
  todayUsageTotal,
  getSetting,
  setSetting,
  type AccountRow,
} from "../core/db";
import { collectAll, startAutoCollect, EVENT_BALANCE_UPDATED } from "../core/collector";

const win = getCurrentWindow();

const EXPANDED_W = 300;
const EXPANDED_H = 196;
const COLLAPSED_W = 64;

const accounts = ref<AccountRow[]>([]);
const balances = ref<Record<number, { balance: number; currency: string }>>({});
const today = ref<{ input_tokens: number; output_tokens: number; cost: number }>({
  input_tokens: 0,
  output_tokens: 0,
  cost: 0,
});
const collecting = ref(false);
const lastUpdated = ref("");
const lowThreshold = ref(20);

// 折叠相关状态
const collapsed = ref(false); // 最终 UI 状态（窄条 or 完整卡）
const collapsedEdge = ref<"left" | "right" | null>(null);
const fullVisible = ref(true); // 完整卡片透明度控制（CSS transition）
const collVisible = ref(false); // 窄条透明度控制
const animating = ref(false); // 动画进行中
let suppressSnapUntil = 0; // 抑制贴边折叠的时间戳

let unlistenEvent: UnlistenFn | null = null;
let unlistenMove: UnlistenFn | null = null;
let moveTimer: number | null = null;

function fmt(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTok(n: number): string {
  return n.toLocaleString("zh-CN");
}

function statusColor(balance: number): string {
  if (balance <= lowThreshold.value) return "#f87171";
  if (balance <= lowThreshold.value * 3) return "#fbbf24";
  return "#34d399";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 窗口/折叠 ----------

async function getLogicalMetrics(): Promise<{
  scale: number;
  screenW: number;
  screenH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  const monitor = await currentMonitor();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const scale = monitor?.scaleFactor ?? 1;
  return {
    scale,
    screenW: (monitor?.size.width ?? 1440) / scale,
    screenH: (monitor?.size.height ?? 900) / scale,
    x: pos.x / scale,
    y: pos.y / scale,
    w: size.width / scale,
    h: size.height / scale,
  };
}

async function saveOverlayPos(): Promise<void> {
  const m = await getLogicalMetrics();
  await setSetting("overlay_pos", JSON.stringify({ x: m.x, y: m.y }));
}

/** 窗口宽度/位置分步动画（easeOutCubic） */
async function animateSize(
  fromW: number,
  toW: number,
  fromX: number,
  toX: number,
  y: number,
  duration = 280
): Promise<void> {
  const steps = Math.max(6, Math.floor(duration / 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const w = Math.round(fromW + (toW - fromW) * ease);
    const x = Math.round(fromX + (toX - fromX) * ease);
    await win.setSize(new LogicalSize(w, EXPANDED_H));
    await win.setPosition(new LogicalPosition(x, y));
    await sleep(30);
  }
}

/** 折叠到边缘 */
async function doCollapse(target: "left" | "right"): Promise<void> {
  if (animating.value || collapsed.value) return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  collapsedEdge.value = target;

  // 1. 完整卡片淡出
  fullVisible.value = false;
  await sleep(160);

  // 2. 窗口收缩动画（内容已透明，只看到背景收缩）
  const m = await getLogicalMetrics();
  const toX = target === "right" ? Math.max(0, m.screenW - COLLAPSED_W) : 0;
  await animateSize(m.w, COLLAPSED_W, m.x, toX, m.y);

  // 3. 窄条淡入
  collapsed.value = true;
  collVisible.value = true;
  await sleep(80);
  animating.value = false;

  await setSetting("overlay_collapsed", "1");
  await saveOverlayPos();
}

/** 展开为完整悬浮卡 */
async function expand(): Promise<void> {
  if (animating.value || !collapsed.value) return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;

  // 1. 窄条淡出
  collVisible.value = false;
  await sleep(160);

  // 2. 窗口扩展动画（右对齐保持右缘）
  const m = await getLogicalMetrics();
  const toX =
    collapsedEdge.value === "right" ? Math.max(0, m.screenW - EXPANDED_W) : 0;
  await animateSize(m.w, EXPANDED_W, m.x, toX, m.y);

  // 3. 完整卡片淡入
  collapsed.value = false;
  fullVisible.value = true;
  await sleep(80);
  animating.value = false;

  await setSetting("overlay_collapsed", "0");
  await saveOverlayPos();
}

/** 拖动结束/位置变化后：贴边则折叠 */
async function maybeSnapToEdge(): Promise<void> {
  if (Date.now() < suppressSnapUntil) return;
  const m = await getLogicalMetrics();
  const margin = 24;
  let target: "left" | "right" | null = null;
  if (m.x <= margin) target = "left";
  else if (m.x + m.w >= m.screenW - margin) target = "right";

  if (target && !collapsed.value) {
    await doCollapse(target);
  } else if (!target && collapsed.value) {
    await expand();
  } else if (!target) {
    await saveOverlayPos();
  }
}

// ---------- 数据 ----------

async function refresh(): Promise<void> {
  if (collecting.value) return;
  collecting.value = true;
  try {
    await collectAll();
  } catch (e) {
    console.error(e);
  }
  collecting.value = false;
  await loadData();
}

async function loadData(): Promise<void> {
  accounts.value = await listAccounts();
  const lbs = await latestBalances();
  const map: Record<number, { balance: number; currency: string }> = {};
  for (const lb of lbs) {
    map[lb.account_id] = { balance: lb.balance, currency: lb.currency };
  }
  balances.value = map;
  today.value = await todayUsageTotal();
  const t = await getSetting("last_collect_at");
  lastUpdated.value = t
    ? new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "";
}

function openDashboard(): void {
  void invoke("show_window", { label: "dashboard" });
}
function hideOverlay(): void {
  void invoke("hide_window", { label: "overlay" });
}

onMounted(async () => {
  await initDb();
  await loadData();

  // 恢复上次位置与折叠状态
  try {
    const posRaw = await getSetting("overlay_pos");
    if (posRaw) {
      const { x, y } = JSON.parse(posRaw) as { x: number; y: number };
      await win.setPosition(new LogicalPosition(x, y));
    }
    const coll = await getSetting("overlay_collapsed");
    if (coll === "1") {
      collapsed.value = true;
      fullVisible.value = false;
      collVisible.value = true;
      const m = await getLogicalMetrics();
      collapsedEdge.value = m.x <= m.screenW / 2 ? "left" : "right";
      await win.setSize(new LogicalSize(COLLAPSED_W, EXPANDED_H));
    }
  } catch (e) {
    console.error("恢复悬浮卡状态失败", e);
  }

  // 拖动结束贴边判断
  unlistenMove = await win.onMoved(() => {
    if (moveTimer) window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => void maybeSnapToEdge(), 350);
  });

  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  startAutoCollect();
  unlistenEvent = await listen(EVENT_BALANCE_UPDATED, () => void loadData());
  void refresh();
});

onUnmounted(() => {
  unlistenEvent?.();
  unlistenMove?.();
  if (moveTimer) window.clearTimeout(moveTimer);
});
</script>

<template>
  <!-- 折叠窄条：点击展开 -->
  <div
    class="collapsed-bar"
    :class="{ 'fade-out': !collVisible }"
    @click="expand"
    title="点击展开"
  >
    <span class="c-dot" :class="{ online: !collecting }"></span>
    <span class="c-title">AI</span>
    <span class="c-arrow">›</span>
  </div>

  <!-- 完整悬浮卡 -->
  <div class="overlay-card" :class="{ 'fade-out': !fullVisible }">
    <div class="bar" data-tauri-drag-region>
      <div class="title" data-tauri-drag-region>
        <span class="dot" :class="{ online: !collecting }"></span>
        AI 用量监控
      </div>
      <div class="actions">
        <button class="icon-btn" title="刷新" :disabled="collecting" @click="refresh">⟳</button>
        <button class="icon-btn" title="展开面板" @click="openDashboard">⤢</button>
        <button class="icon-btn" title="隐藏到托盘" @click="hideOverlay">—</button>
      </div>
    </div>

    <div class="body">
      <div v-if="accounts.length === 0" class="empty" @click="openDashboard">
        尚未添加账户<br />
        <span>点击这里打开面板添加</span>
      </div>
      <div v-for="acc in accounts" v-else :key="acc.id" class="acc-row">
        <div class="acc-name">{{ acc.name }}</div>
        <div class="acc-bal" :style="{ color: statusColor(balances[acc.id]?.balance ?? 0) }">
          {{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}
          <span class="currency">{{ balances[acc.id]?.currency ?? "" }}</span>
        </div>
      </div>
    </div>

    <div class="footer">
      <span>
        今日 {{ fmtTok(today.input_tokens) }}/{{ fmtTok(today.output_tokens) }} tok ·
        ¥{{ fmt(today.cost) }}
      </span>
      <span class="time">{{ lastUpdated ? "更新于 " + lastUpdated : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
.overlay-card,
.collapsed-bar {
  transition: opacity 0.16s ease;
}

.fade-out {
  opacity: 0;
  pointer-events: none;
}

.overlay-card {
  width: 100%;
  height: 100vh;
  background: rgba(15, 17, 23, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e5e7eb;
  font-size: 12px;
  user-select: none;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  flex-shrink: 0;
}

.title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fbbf24;
}
.dot.online {
  background: #34d399;
}

.actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 5px;
  line-height: 1;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #9ca3af;
  cursor: pointer;
  gap: 4px;
}
.empty span {
  font-size: 11px;
  color: #6b7280;
}

.acc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.acc-row:last-child {
  border-bottom: none;
}
.acc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 130px;
  color: #d1d5db;
}
.acc-bal {
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.currency {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.6;
  margin-left: 2px;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: #9ca3af;
  flex-shrink: 0;
}
.footer b {
  color: #e5e7eb;
  font-variant-numeric: tabular-nums;
}
.time {
  font-size: 10px;
  color: #6b7280;
}

/* 折叠窄条 */
.collapsed-bar {
  width: 100%;
  height: 100vh;
  background: rgba(15, 17, 23, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #e5e7eb;
  cursor: pointer;
  user-select: none;
}
.collapsed-bar:hover {
  background: rgba(25, 28, 38, 0.95);
}
.c-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fbbf24;
}
.c-dot.online {
  background: #34d399;
}
.c-title {
  font-weight: 700;
  font-size: 13px;
}
.c-arrow {
  color: #6b7280;
  font-size: 14px;
}
</style>
