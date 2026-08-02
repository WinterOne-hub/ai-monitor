<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  initDb,
  listAccounts,
  latestBalances,
  todayUsageTotal,
  getSetting,
  type AccountRow,
} from "../core/db";
import { collectAll, startAutoCollect, EVENT_BALANCE_UPDATED } from "../core/collector";

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
let unlisten: UnlistenFn | null = null;

function fmt(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusColor(balance: number): string {
  if (balance <= lowThreshold.value) return "#f87171";
  if (balance <= lowThreshold.value * 3) return "#fbbf24";
  return "#34d399";
}

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
  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  startAutoCollect();
  unlisten = await listen(EVENT_BALANCE_UPDATED, () => void loadData());
  void refresh();
});

onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <div class="overlay-card">
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
        <div
          class="acc-bal"
          :style="{ color: statusColor(balances[acc.id]?.balance ?? 0) }"
        >
          {{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}
          <span class="currency">{{ balances[acc.id]?.currency ?? "" }}</span>
        </div>
      </div>
    </div>

    <div class="footer">
      <span>今日消耗 <b>¥{{ fmt(today.cost) }}</b></span>
      <span class="time">{{ lastUpdated ? "更新于 " + lastUpdated : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
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
</style>
