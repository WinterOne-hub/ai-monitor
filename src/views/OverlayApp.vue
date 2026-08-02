<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
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

// 灵动岛三态尺寸（逻辑像素）
const CAPSULE_W = 320;
const CAPSULE_H = 64;
const EXPANDED_H = 240;
const EDGE_W = 32; // 边缘半圆窗口宽（完全在屏幕内，贴边凸出半圆）
const EDGE_H = 64;
const TOP_Y = 48; // 顶部居中的 Y

type Mode = "capsule" | "expanded" | "edge";

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

// 状态
const mode = ref<Mode>("capsule");
const edgeSide = ref<"left" | "right" | null>(null);
const capsuleVisible = ref(true);
const expandedVisible = ref(false);
const edgeVisible = ref(false);
const animating = ref(false);
let suppressSnapUntil = 0;

let unlistenEvent: UnlistenFn | null = null;
let unlistenMove: UnlistenFn | null = null;
let unlistenFocus: UnlistenFn | null = null;
let moveTimer: number | null = null;

const totalBalance = computed(() =>
  Object.values(balances.value).reduce((s, b) => s + b.balance, 0)
);

function fmt(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function compactTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function todayLabel(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function statusColor(balance: number): string {
  if (balance <= lowThreshold.value) return "#f87171";
  if (balance <= lowThreshold.value * 3) return "#fbbf24";
  return "#34d399";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 窗口几何 ----------

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

async function savePos(): Promise<void> {
  const m = await getLogicalMetrics();
  // 校正到屏幕内
  const x = Math.max(0, Math.min(m.x, Math.max(0, m.screenW - m.w)));
  const y = Math.max(0, Math.min(m.y, Math.max(0, m.screenH - m.h)));
  await setSetting("overlay_pos", JSON.stringify({ x, y }));
  await setSetting("overlay_mode", mode.value);
}

/** 窗口尺寸/位置分步动画 */
async function animateSize(
  fromW: number,
  toW: number,
  fromH: number,
  toH: number,
  fromX: number,
  toX: number,
  fromY: number,
  toY: number,
  duration = 280
): Promise<void> {
  const steps = Math.max(6, Math.floor(duration / 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const w = Math.round(fromW + (toW - fromW) * ease);
    const h = Math.round(fromH + (toH - fromH) * ease);
    const x = Math.round(fromX + (toX - fromX) * ease);
    const y = Math.round(fromY + (toY - fromY) * ease);
    await win.setSize(new LogicalSize(w, h));
    await win.setPosition(new LogicalPosition(x, y));
    await sleep(30);
  }
}

/** 移动到顶部居中（灵动岛默认位） */
async function centerTop(): Promise<void> {
  const m = await getLogicalMetrics();
  const x = Math.max(0, Math.round((m.screenW - CAPSULE_W) / 2));
  await win.setPosition(new LogicalPosition(x, TOP_Y));
  await savePos();
}

// ---------- 状态切换 ----------

/** 胶囊 -> 展开卡片 */
async function expand(): Promise<void> {
  if (animating.value || mode.value === "expanded") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  capsuleVisible.value = false;
  await sleep(140);
  const m = await getLogicalMetrics();
  await animateSize(m.w, CAPSULE_W, m.h, EXPANDED_H, m.x, m.x, m.y, m.y);
  mode.value = "expanded";
  expandedVisible.value = true;
  await sleep(80);
  animating.value = false;
  await savePos();
}

/** 卡片 -> 收回胶囊 */
async function collapseToCapsule(): Promise<void> {
  if (animating.value || mode.value !== "expanded") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  expandedVisible.value = false;
  await sleep(140);
  const m = await getLogicalMetrics();
  await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, m.x, m.y, m.y);
  mode.value = "capsule";
  capsuleVisible.value = true;
  await sleep(80);
  animating.value = false;
  await savePos();
}

/** 贴边 -> 小半圆（窗口贴边、完全在屏幕内，向屏幕内凸出半圆） */
async function collapseToEdge(target: "left" | "right"): Promise<void> {
  if (animating.value || mode.value === "edge") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  edgeSide.value = target;
  // 隐藏当前内容
  capsuleVisible.value = false;
  expandedVisible.value = false;
  await sleep(140);
  const m = await getLogicalMetrics();
  const toX = target === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
  await animateSize(m.w, EDGE_W, m.h, EDGE_H, m.x, toX, m.y, m.y);
  mode.value = "edge";
  edgeVisible.value = true;
  await sleep(80);
  animating.value = false;
  await savePos();
}

/** 半圆 -> 向屏幕内推出完整胶囊 */
async function expandFromEdge(): Promise<void> {
  if (animating.value || mode.value !== "edge") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  edgeVisible.value = false;
  await sleep(140);
  const m = await getLogicalMetrics();
  const toX = edgeSide.value === "right" ? Math.max(0, m.screenW - CAPSULE_W) : 0;
  await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, toX, m.y, m.y);
  mode.value = "capsule";
  capsuleVisible.value = true;
  await sleep(80);
  animating.value = false;
  await savePos();
}

/** 拖动结束：距边缘较近则吸附折叠成小半圆 */
async function maybeSnapToEdge(): Promise<void> {
  if (Date.now() < suppressSnapUntil) return;
  if (mode.value !== "capsule" && mode.value !== "expanded") return;
  const m = await getLogicalMetrics();
  const EDGE_ZONE = 80; // 边缘吸附区（逻辑像素），左右对称
  const leftDist = m.x;
  const rightDist = m.screenW - (m.x + m.w);
  let target: "left" | "right" | null = null;
  if (leftDist <= EDGE_ZONE && leftDist < rightDist) target = "left";
  else if (rightDist <= EDGE_ZONE && rightDist < leftDist) target = "right";
  if (target) {
    await collapseToEdge(target);
  } else {
    await savePos();
  }
}

/** 胶囊主点击：展开/收回 */
function onCapsuleClick(): void {
  if (mode.value === "capsule") void expand();
}

/** 边条点击：展开胶囊 */
function onEdgeClick(): void {
  if (mode.value === "edge") void expandFromEdge();
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
  void invoke("log_js", { msg: "overlay mounted" });
  await initDb();
  await loadData();

  // 恢复位置与模式
  try {
    const posRaw = await getSetting("overlay_pos");
    if (posRaw) {
      const m = await getLogicalMetrics();
      const { x, y } = JSON.parse(posRaw) as { x: number; y: number };
      const sx = Math.max(0, Math.min(x, Math.max(0, m.screenW - CAPSULE_W)));
      const sy = Math.max(0, Math.min(y, Math.max(0, m.screenH - EXPANDED_H)));
      await win.setPosition(new LogicalPosition(sx, sy));
    } else {
      await centerTop();
    }
    const savedMode = await getSetting("overlay_mode");
    if (savedMode === "expanded") {
      await win.setSize(new LogicalSize(CAPSULE_W, EXPANDED_H));
      mode.value = "expanded";
      expandedVisible.value = true;
      capsuleVisible.value = false;
    } else if (savedMode === "edge") {
      const m = await getLogicalMetrics();
      edgeSide.value = m.x <= m.screenW / 2 ? "left" : "right";
      const ex = edgeSide.value === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
      await win.setPosition(new LogicalPosition(ex, m.y));
      await win.setSize(new LogicalSize(EDGE_W, EDGE_H));
      mode.value = "edge";
      edgeVisible.value = true;
      capsuleVisible.value = false;
    }
  } catch (e) {
    console.error("恢复状态失败", e);
  }

  // 拖动结束贴边判断（胶囊态/展开态均可拖动）
  unlistenMove = await win.onMoved(() => {
    if (moveTimer) window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => void maybeSnapToEdge(), 350);
  });

  // 点击屏幕其他地方 -> 收回胶囊
  unlistenFocus = await win.onFocusChanged(({ payload }) => {
    if (!payload && mode.value === "expanded") void collapseToCapsule();
  });

  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  startAutoCollect();
  unlistenEvent = await listen(EVENT_BALANCE_UPDATED, () => void loadData());
  void refresh();

  // 诊断：恢复后的实际窗口位置
  const pos = await win.outerPosition();
  const sz = await win.outerSize();
  void invoke("log_js", {
    msg: `overlay final pos=${pos.x},${pos.y} size=${sz.width}x${sz.height} mode=${mode.value}`,
  });
});

onUnmounted(() => {
  unlistenEvent?.();
  unlistenMove?.();
  unlistenFocus?.();
  if (moveTimer) window.clearTimeout(moveTimer);
});
</script>

<template>
  <!-- 灵动岛胶囊 -->
  <div
    v-show="capsuleVisible"
    class="island capsule"
    :class="{ 'fade-out': !capsuleVisible }"
    @click="onCapsuleClick"
  >
    <div class="capsule-inner" data-tauri-drag-region>
      <span class="dot" :class="{ online: !collecting }"></span>
      <span class="brand" data-tauri-drag-region>AI 用量</span>
      <span class="divider" data-tauri-drag-region></span>
      <span class="bal" :style="{ color: statusColor(totalBalance) }" data-tauri-drag-region>
        ¥{{ fmt(totalBalance) }}
      </span>
      <span class="tok" data-tauri-drag-region>
        今日 {{ compactTok(today.input_tokens + today.output_tokens) }}
      </span>
      <span class="chevron">›</span>
    </div>
  </div>

  <!-- 展开卡片 -->
  <div v-show="expandedVisible" class="island expanded" :class="{ 'fade-out': !expandedVisible }">
    <div class="expanded-head" data-tauri-drag-region>
      <div class="head-left">
        <span class="dot" :class="{ online: !collecting }"></span>
        <span class="brand">AI 用量监控</span>
      </div>
      <div class="head-actions">
        <button class="icon-btn" title="刷新" :disabled="collecting" @click="refresh">⟳</button>
        <button class="icon-btn" title="打开面板" @click="openDashboard">⤢</button>
        <button class="icon-btn" title="收回" @click="collapseToCapsule">⌄</button>
        <button class="icon-btn" title="隐藏到托盘" @click="hideOverlay">—</button>
      </div>
    </div>

    <div class="expanded-body">
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

    <div class="expanded-footer">
      <span class="date">{{ todayLabel() }}</span>
      <span class="tokens">
        今日 {{ compactTok(today.input_tokens) }}/{{ compactTok(today.output_tokens) }} tok
      </span>
      <span class="cost">¥{{ fmt(today.cost) }}</span>
      <span class="time">{{ lastUpdated ? "更新 " + lastUpdated : "" }}</span>
    </div>
  </div>

  <!-- 边缘小半圆 -->
  <div
    v-show="edgeVisible"
    class="island edge"
    :class="[
      { 'fade-out': !edgeVisible },
      edgeSide === 'right' ? 'edge-right' : 'edge-left',
    ]"
    @click="onEdgeClick"
    title="点击推出"
  >
    <span class="dot" :class="{ online: !collecting }"></span>
    <span class="c-title">AI</span>
  </div>
</template>

<style scoped>
.island {
  background: rgba(18, 20, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e5e7eb;
  user-select: none;
  transition: opacity 0.14s ease;
  overflow: hidden;
}
.fade-out {
  opacity: 0;
  pointer-events: none;
}

/* ---- 胶囊 ---- */
.capsule {
  width: 100%;
  height: 100vh;
  border-radius: 32px;
  cursor: pointer;
}
.capsule-inner {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  font-size: 12px;
}
.capsule:hover {
  background: rgba(26, 29, 40, 0.98);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fbbf24;
  flex-shrink: 0;
}
.dot.online {
  background: #34d399;
}

.brand {
  font-weight: 700;
  font-size: 12px;
  white-space: nowrap;
}
.divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
}
.bal {
  font-weight: 700;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tok {
  color: #9ca3af;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  margin-left: auto;
}
.chevron {
  color: #6b7280;
  font-size: 16px;
  flex-shrink: 0;
}

/* ---- 展开卡片 ---- */
.expanded {
  width: 100%;
  height: 100vh;
  border-radius: 20px;
  display: flex;
  flex-direction: column;
}
.expanded-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 7px;
}
.head-actions {
  display: flex;
  gap: 2px;
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

.expanded-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 14px;
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
  font-size: 12px;
}
.empty span {
  font-size: 11px;
  color: #6b7280;
}
.acc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.acc-row:last-child {
  border-bottom: none;
}
.acc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 170px;
  color: #d1d5db;
  font-size: 12px;
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

.expanded-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
}
.date {
  color: #e5e7eb;
  font-weight: 600;
}
.tokens {
  font-variant-numeric: tabular-nums;
}
.cost {
  color: #fbbf24;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.time {
  margin-left: auto;
  font-size: 10px;
  color: #6b7280;
}

/* ---- 边缘小半圆（窗口贴边、完全在屏幕内） ---- */
.edge {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
}
/* 左边缘：左端平面贴边，右端半圆凸出 */
.edge-left {
  border-radius: 0 32px 32px 0;
}
/* 右边缘：右端平面贴边，左端半圆凸出 */
.edge-right {
  border-radius: 32px 0 0 32px;
}
.edge:hover {
  background: rgba(26, 29, 40, 0.98);
}
.c-title {
  font-weight: 700;
  font-size: 11px;
}
</style>
