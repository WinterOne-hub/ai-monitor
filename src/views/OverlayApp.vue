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
  todayUsageByAccount,
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
const todayByAccount = ref<Record<number, { input_tokens: number; output_tokens: number; cost: number }>>({});
const collecting = ref(false);
const lastUpdated = ref("");
const lowThreshold = ref(20);

// 状态
const mode = ref<Mode>("capsule");
const edgeSide = ref<"left" | "right" | null>(null);
const animating = ref(false);
let suppressSnapUntil = 0;

let unlistenEvent: UnlistenFn | null = null;
let unlistenUsage: UnlistenFn | null = null;
let unlistenMove: UnlistenFn | null = null;
let unlistenFocus: UnlistenFn | null = null;
let moveTimer: number | null = null;
let uiTimer: ReturnType<typeof setInterval> | null = null;
let hoverTimer: number | null = null;

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
  const x = Math.max(0, Math.min(m.x, Math.max(0, m.screenW - m.w)));
  const y = Math.max(0, Math.min(m.y, Math.max(0, m.screenH - m.h)));
  await setSetting("overlay_pos", JSON.stringify({ x, y }));
  await setSetting("overlay_mode", mode.value);
}

/** 窗口尺寸/位置分步动画（easeOutCubic） */
async function animateSize(
  fromW: number,
  toW: number,
  fromH: number,
  toH: number,
  fromX: number,
  toX: number,
  fromY: number,
  toY: number,
  duration = 300
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

/** 移动到顶部居中 */
async function centerTop(): Promise<void> {
  const m = await getLogicalMetrics();
  const x = Math.max(0, Math.round((m.screenW - CAPSULE_W) / 2));
  await win.setPosition(new LogicalPosition(x, TOP_Y));
  await savePos();
}

// ---------- 状态切换（抽屉式） ----------

/** 胶囊 -> 展开卡片（窗口向下延伸，抽屉下拉） */
async function expand(): Promise<void> {
  if (animating.value || mode.value === "expanded") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  const m = await getLogicalMetrics();
  await animateSize(m.w, CAPSULE_W, m.h, EXPANDED_H, m.x, m.x, m.y, m.y);
  mode.value = "expanded";
  animating.value = false;
  await savePos();
}

/** 卡片 -> 收回胶囊（抽屉收起） */
async function collapseToCapsule(): Promise<void> {
  if (animating.value || mode.value !== "expanded") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  const m = await getLogicalMetrics();
  await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, m.x, m.y, m.y);
  mode.value = "capsule";
  animating.value = false;
  await savePos();
}

/** 贴边 -> 小半圆 */
async function collapseToEdge(target: "left" | "right"): Promise<void> {
  if (animating.value || mode.value === "edge") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  edgeSide.value = target;
  const m = await getLogicalMetrics();
  const toX = target === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
  await animateSize(m.w, EDGE_W, m.h, EDGE_H, m.x, toX, m.y, m.y);
  mode.value = "edge";
  animating.value = false;
  await savePos();
}

/** 半圆 -> 向屏幕内推出胶囊 */
async function expandFromEdge(): Promise<void> {
  if (animating.value || mode.value !== "edge") return;
  animating.value = true;
  suppressSnapUntil = Date.now() + 2000;
  const m = await getLogicalMetrics();
  const toX = edgeSide.value === "right" ? Math.max(0, m.screenW - CAPSULE_W) : 0;
  await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, toX, m.y, m.y);
  mode.value = "capsule";
  animating.value = false;
  await savePos();
}

/** 拖动结束：距边缘较近则吸附折叠成小半圆 */
async function maybeSnapToEdge(): Promise<void> {
  if (Date.now() < suppressSnapUntil) return;
  if (mode.value !== "capsule" && mode.value !== "expanded") return;
  const m = await getLogicalMetrics();
  const EDGE_ZONE = 80;
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

/** hover：鼠标进入 -> 丝滑展开 */
function onHoverEnter(): void {
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    if (animating.value) return;
    if (mode.value === "capsule") void expand();
    else if (mode.value === "edge") void expandFromEdge();
  }, 80);
}

/** hover：鼠标移走 -> 自动收起 */
function onHoverLeave(): void {
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    if (animating.value) return;
    if (mode.value === "expanded") void collapseToCapsule();
  }, 150);
}

/** 胶囊点击（兜底） */
function onCapsuleClick(): void {
  if (mode.value === "capsule") void expand();
}

/** 边条点击（兜底） */
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
  const byAcc = await todayUsageByAccount();
  const accMap: Record<number, { input_tokens: number; output_tokens: number; cost: number }> = {};
  for (const u of byAcc) {
    accMap[u.account_id] = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost: u.cost };
  }
  todayByAccount.value = accMap;
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
    } else if (savedMode === "edge") {
      const m = await getLogicalMetrics();
      edgeSide.value = m.x <= m.screenW / 2 ? "left" : "right";
      const ex = edgeSide.value === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
      await win.setPosition(new LogicalPosition(ex, m.y));
      await win.setSize(new LogicalSize(EDGE_W, EDGE_H));
      mode.value = "edge";
    }
  } catch (e) {
    console.error("恢复状态失败", e);
  }

  // 拖动结束贴边判断
  unlistenMove = await win.onMoved(() => {
    if (moveTimer) window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => void maybeSnapToEdge(), 350);
  });

  // 点击屏幕其他地方 -> 收回胶囊（兜底）
  unlistenFocus = await win.onFocusChanged(({ payload }) => {
    if (!payload && mode.value === "expanded" && !animating.value) void collapseToCapsule();
  });

  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  startAutoCollect();
  unlistenEvent = await listen(EVENT_BALANCE_UPDATED, () => void loadData());

  // 代理记账后即时刷新
  unlistenUsage = await listen("usage-updated", () => void loadData());

  // 兜底：每 30 秒刷新本地数据
  uiTimer = setInterval(() => void loadData(), 30_000);

  void refresh();
});

onUnmounted(() => {
  unlistenEvent?.();
  unlistenUsage?.();
  unlistenMove?.();
  unlistenFocus?.();
  if (moveTimer) window.clearTimeout(moveTimer);
  if (uiTimer) window.clearInterval(uiTimer);
  if (hoverTimer) window.clearTimeout(hoverTimer);
});
</script>

<template>
  <!-- 边缘小半圆 -->
  <div
    v-show="mode === 'edge'"
    class="island edge"
    :class="edgeSide === 'right' ? 'edge-right' : 'edge-left'"
    @mouseenter="onHoverEnter"
    @mouseleave="onHoverLeave"
    @click="onEdgeClick"
    title="点击推出"
  >
    <span class="dot" :class="{ online: !collecting }"></span>
    <span class="c-title">AI</span>
  </div>

  <!-- 灵动岛主体：胶囊/展开（抽屉式） -->
  <div
    v-show="mode !== 'edge'"
    class="island main"
    @mouseenter="onHoverEnter"
    @mouseleave="onHoverLeave"
  >
    <!-- 顶部行（胶囊内容 / 展开 header） -->
    <div class="cap-row" data-tauri-drag-region @click="onCapsuleClick">
      <span class="dot" :class="{ online: !collecting }"></span>
      <span class="brand">AI 用量</span>
      <span class="divider"></span>
      <span class="bal" :style="{ color: statusColor(totalBalance) }">¥{{ fmt(totalBalance) }}</span>
      <span class="spend">-¥{{ fmt(today.cost) }}</span>
      <span class="tok">{{ compactTok(today.input_tokens + today.output_tokens) }} tok</span>
      <span v-if="mode === 'capsule'" class="chevron">›</span>
      <div v-else class="head-actions">
        <button class="icon-btn" title="刷新" :disabled="collecting" @click.stop="refresh">⟳</button>
        <button class="icon-btn" title="打开面板" @click.stop="openDashboard">⤢</button>
        <button class="icon-btn" title="隐藏到托盘" @click.stop="hideOverlay">—</button>
      </div>
    </div>

    <!-- 抽屉内容（展开时下拉露出） -->
    <div class="drawer">
      <div class="drawer-body">
        <div v-if="accounts.length === 0" class="empty" @click="openDashboard">
          尚未添加账户<br />
          <span>点击这里打开面板添加</span>
        </div>
        <div v-for="acc in accounts" v-else :key="acc.id" class="acc-row">
          <div class="acc-name">{{ acc.name }}</div>
          <div class="acc-metrics">
            <span class="m-bal" :style="{ color: statusColor(balances[acc.id]?.balance ?? 0) }">
              {{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}
            </span>
            <span class="m-cost">-¥{{ fmt(todayByAccount[acc.id]?.cost ?? 0) }}</span>
            <span class="m-tok">
              {{ compactTok((todayByAccount[acc.id]?.input_tokens ?? 0) + (todayByAccount[acc.id]?.output_tokens ?? 0)) }}
              tok
            </span>
          </div>
        </div>
      </div>
      <div class="drawer-footer">
        <span class="date">{{ todayLabel() }}</span>
        <span class="tokens">
          今日 {{ compactTok(today.input_tokens) }}/{{ compactTok(today.output_tokens) }} tok
        </span>
        <span class="cost">¥{{ fmt(today.cost) }}</span>
        <span class="time">{{ lastUpdated ? "更新 " + lastUpdated : "" }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.island {
  background: rgba(18, 20, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e5e7eb;
  user-select: none;
  overflow: hidden;
}

/* ---- 主体（胶囊/展开共用容器） ---- */
.main {
  width: 100%;
  height: 100vh;
  border-radius: 20px;
  display: flex;
  flex-direction: column;
}

/* 顶部行：胶囊态 64px，展开态作为 header */
.cap-row {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  font-size: 12px;
  cursor: pointer;
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
.spend {
  color: #f87171;
  font-size: 12px;
  font-weight: 600;
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

.head-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
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

/* 抽屉内容（展开时随窗口高度露出） */
.drawer {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 14px;
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
  gap: 8px;
  padding: 5px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.acc-row:last-child {
  border-bottom: none;
}
.acc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 90px;
  color: #d1d5db;
  font-size: 12px;
  flex-shrink: 0;
}
.acc-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.m-bal {
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
.m-cost {
  color: #f87171;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: right;
}
.m-tok {
  color: #9ca3af;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 64px;
  text-align: right;
  white-space: nowrap;
}

.drawer-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
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

/* ---- 边缘小半圆 ---- */
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
.edge-left {
  border-radius: 0 32px 32px 0;
}
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
