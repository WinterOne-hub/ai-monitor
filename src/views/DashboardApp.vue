<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  initDb,
  listAccounts,
  latestBalances,
  todayUsageTotal,
  getSetting,
  setSetting,
  type AccountRow,
} from "../core/db";
import {
  collectAll,
  collectAccount,
  deleteAccountAndSecret,
  getCollectIntervalMinutes,
  setCollectIntervalMinutes,
  EVENT_BALANCE_UPDATED,
} from "../core/collector";
import { providers, getProvider } from "../providers";

type Tab = "accounts" | "usage" | "settings";

const tab = ref<Tab>("accounts");
const accounts = ref<AccountRow[]>([]);
const balances = ref<Record<number, { balance: number; currency: string; fetched_at: string }>>({});
const today = ref<{ input_tokens: number; output_tokens: number; cost: number }>({
  input_tokens: 0,
  output_tokens: 0,
  cost: 0,
});
const collecting = ref(false);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// 添加表单
const formProvider = ref("deepseek");
const formName = ref("");
const formKey = ref("");
const adding = ref(false);

// 设置
const intervalMinutes = ref(30);
const lowThreshold = ref("20");

const totalBalance = computed(() =>
  Object.values(balances.value).reduce((s, b) => s + b.balance, 0)
);

function showToast(msg: string): void {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 3500);
}

function fmt(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function loadData(): Promise<void> {
  accounts.value = await listAccounts();
  const lbs = await latestBalances();
  const map: Record<number, { balance: number; currency: string; fetched_at: string }> = {};
  for (const lb of lbs) {
    map[lb.account_id] = {
      balance: lb.balance,
      currency: lb.currency,
      fetched_at: lb.fetched_at,
    };
  }
  balances.value = map;
  today.value = await todayUsageTotal();
}

async function addAccount(): Promise<void> {
  const providerId = formProvider.value;
  const provider = getProvider(providerId);
  const name = formName.value.trim() || provider?.name || providerId;
  const key = formKey.value.trim();
  if (!key) {
    showToast("请填写 API Key");
    return;
  }
  adding.value = true;
  try {
    const { addAccount } = await import("../core/db");
    const id = await addAccount(providerId, name);
    await invoke("save_secret", { account: String(id), secret: key });
    if (provider?.balanceSupported) {
      const acc = (await listAccounts()).find((a) => a.id === id);
      if (acc) await collectAccount(acc);
    }
    formKey.value = "";
    formName.value = "";
    showToast(`已添加账户「${name}」`);
    await loadData();
  } catch (e) {
    showToast(`添加失败：${(e as Error).message}`);
  } finally {
    adding.value = false;
  }
}

async function removeAccount(acc: AccountRow): Promise<void> {
  await deleteAccountAndSecret(acc.id);
  showToast(`已删除「${acc.name}」及其密钥`);
  await loadData();
}

async function refreshOne(acc: AccountRow): Promise<void> {
  try {
    await collectAccount(acc);
    showToast(`「${acc.name}」已刷新`);
  } catch (e) {
    showToast(`刷新失败：${(e as Error).message}`);
  }
  await loadData();
}

async function refreshAll(): Promise<void> {
  if (collecting.value) return;
  collecting.value = true;
  try {
    const result = await collectAll();
    showToast(`刷新完成：成功 ${result.ok}，失败 ${result.failed}`);
  } catch (e) {
    showToast(`刷新失败：${(e as Error).message}`);
  }
  collecting.value = false;
  await loadData();
}

async function saveInterval(): Promise<void> {
  const m = await setCollectIntervalMinutes(parseInt(String(intervalMinutes.value), 10) || 30);
  intervalMinutes.value = m;
  showToast(`采集间隔已设为 ${m} 分钟`);
}

async function saveThreshold(): Promise<void> {
  const v = parseInt(lowThreshold.value, 10);
  if (Number.isNaN(v) || v < 0) {
    showToast("请输入有效数值");
    return;
  }
  await setSetting("low_balance_threshold", String(v));
  showToast(`低余额提醒阈值已设为 ¥${v}`);
}

function hidePanel(): void {
  void invoke("hide_window", { label: "dashboard" });
}

let unlisten: UnlistenFn | null = null;
onMounted(async () => {
  await initDb();
  await loadData();
  intervalMinutes.value = await getCollectIntervalMinutes();
  lowThreshold.value = (await getSetting("low_balance_threshold")) ?? "20";
  unlisten = await listen(EVENT_BALANCE_UPDATED, () => void loadData());
});
onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <div class="dashboard-root">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>AI 用量监控</span>
      </div>
      <div class="topbar-right">
        <button class="btn" :disabled="collecting" @click="refreshAll">
          {{ collecting ? "采集中…" : "全部刷新" }}
        </button>
        <button class="btn ghost" @click="hidePanel">隐藏到托盘</button>
      </div>
    </header>

    <nav class="tabs">
      <button
        v-for="t in (['accounts', 'usage', 'settings'] as Tab[])"
        :key="t"
        class="tab"
        :class="{ active: tab === t }"
        @click="tab = t"
      >
        {{ { accounts: "账户", usage: "用量分析", settings: "设置" }[t] }}
      </button>
    </nav>

    <main class="content">
      <!-- 账户 -->
      <section v-if="tab === 'accounts'">
        <div class="stat-row">
          <div class="stat-card">
            <div class="stat-label">账户总数</div>
            <div class="stat-value">{{ accounts.length }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">总余额</div>
            <div class="stat-value">{{ fmt(totalBalance) }} <span class="unit">¥</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">今日消耗</div>
            <div class="stat-value">{{ fmt(today.cost) }} <span class="unit">¥</span></div>
          </div>
        </div>

        <div class="panel">
          <h3>添加账户</h3>
          <div class="form-row">
            <select v-model="formProvider" class="input select">
              <option v-for="p in providers" :key="p.id" :value="p.id">
                {{ p.name }}{{ p.balanceSupported ? "" : "（手动登记）" }}
              </option>
            </select>
            <input v-model="formName" class="input" placeholder="备注名（默认平台名）" />
            <input
              v-model="formKey"
              class="input key"
              type="password"
              placeholder="API Key（加密存入系统钥匙串）"
            />
            <button class="btn primary" :disabled="adding" @click="addAccount">
              {{ adding ? "添加中…" : "添加" }}
            </button>
          </div>
          <p v-if="!getProvider(formProvider)?.balanceSupported" class="hint">
            该平台暂不支持自动查询余额，添加后可手动登记余额。
          </p>
        </div>

        <div class="panel">
          <h3>账户列表</h3>
          <div v-if="accounts.length === 0" class="empty-tip">
            还没有账户，添加第一个吧（DeepSeek 开箱即用）
          </div>
          <div v-for="acc in accounts" :key="acc.id" class="acc-card">
            <div class="acc-info">
              <div class="acc-name">{{ acc.name }}</div>
              <div class="acc-sub">
                {{ getProvider(acc.provider_id)?.name ?? acc.provider_id }}
                <template v-if="balances[acc.id]">
                  · 更新于 {{ new Date(balances[acc.id].fetched_at).toLocaleString("zh-CN") }}
                </template>
              </div>
            </div>
            <div class="acc-balance">
              <div class="bal-num">{{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}</div>
              <div class="bal-cur">{{ balances[acc.id]?.currency ?? "" }}</div>
            </div>
            <div class="acc-actions">
              <button class="btn small" @click="refreshOne(acc)">刷新</button>
              <button class="btn small danger" @click="removeAccount(acc)">删除</button>
            </div>
          </div>
        </div>
      </section>

      <!-- 用量 -->
      <section v-else-if="tab === 'usage'">
        <div class="panel">
          <h3>今日用量</h3>
          <div class="usage-grid">
            <div class="usage-item">
              <div class="usage-label">输入 Tokens</div>
              <div class="usage-value">{{ today.input_tokens.toLocaleString() }}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">输出 Tokens</div>
              <div class="usage-value">{{ today.output_tokens.toLocaleString() }}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">估算费用</div>
              <div class="usage-value">¥{{ fmt(today.cost) }}</div>
            </div>
          </div>
          <p class="hint">
            详细的每日用量报表、趋势图与费用分析将在下一版本上线。目前可在「设置」中登记每日用量。
          </p>
        </div>
      </section>

      <!-- 设置 -->
      <section v-else>
        <div class="panel">
          <h3>采集设置</h3>
          <div class="form-row">
            <label class="form-label">自动采集间隔（分钟）</label>
            <input v-model.number="intervalMinutes" class="input num" type="number" min="1" max="1440" />
            <button class="btn" @click="saveInterval">保存</button>
          </div>
          <div class="form-row">
            <label class="form-label">低余额提醒阈值（¥）</label>
            <input v-model="lowThreshold" class="input num" type="number" min="0" />
            <button class="btn" @click="saveThreshold">保存</button>
          </div>
        </div>
        <div class="panel">
          <h3>关于</h3>
          <p class="hint">
            AI 用量监控 v0.1.0 · 本地应用，数据仅存储在本机。<br />
            API Key 加密保存在系统钥匙串（macOS Keychain / Windows DPAPI）。
          </p>
        </div>
      </section>
    </main>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.dashboard-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0f1117;
  color: #e5e7eb;
  font-size: 14px;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
}
.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #34d399;
}
.topbar-right {
  display: flex;
  gap: 8px;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 20px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.tab {
  background: transparent;
  border: none;
  color: #9ca3af;
  padding: 8px 16px;
  cursor: pointer;
  border-radius: 8px 8px 0 0;
  font-size: 14px;
}
.tab.active {
  color: #fff;
  background: rgba(255, 255, 255, 0.06);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 40px;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 14px 16px;
}
.stat-label {
  color: #9ca3af;
  font-size: 12px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 13px;
  color: #9ca3af;
  font-weight: 400;
}

.panel {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.panel h3 {
  margin: 0 0 12px;
  font-size: 14px;
  color: #d1d5db;
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.form-label {
  min-width: 160px;
  color: #9ca3af;
  font-size: 13px;
}
.input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #e5e7eb;
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
}
.input:focus {
  border-color: #34d399;
}
.input.key {
  flex: 1;
  min-width: 220px;
}
.input.num {
  width: 120px;
}
.select {
  width: 180px;
}

.btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e5e7eb;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.primary {
  background: #10b981;
  border-color: #10b981;
  color: #fff;
}
.btn.primary:hover {
  background: #34d399;
}
.btn.ghost {
  background: transparent;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.btn.danger {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.3);
}
.btn.danger:hover {
  background: rgba(248, 113, 113, 0.12);
}

.hint {
  color: #6b7280;
  font-size: 12px;
  margin: 6px 0 0;
  line-height: 1.7;
}

.empty-tip {
  color: #6b7280;
  padding: 20px;
  text-align: center;
}

.acc-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  margin-bottom: 8px;
}
.acc-info {
  flex: 1;
  min-width: 0;
}
.acc-name {
  font-weight: 600;
}
.acc-sub {
  color: #6b7280;
  font-size: 12px;
  margin-top: 2px;
}
.acc-balance {
  text-align: right;
  min-width: 100px;
}
.bal-num {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.bal-cur {
  font-size: 11px;
  color: #6b7280;
}
.acc-actions {
  display: flex;
  gap: 6px;
}

.usage-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.usage-item {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 10px;
  padding: 14px;
}
.usage-label {
  color: #9ca3af;
  font-size: 12px;
  margin-bottom: 6px;
}
.usage-value {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(17, 24, 39, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 10px 20px;
  color: #e5e7eb;
  font-size: 13px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  z-index: 100;
}
</style>
