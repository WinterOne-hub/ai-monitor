<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  initDb,
  listAccounts,
  latestBalances,
  todayUsageTotal,
  saveBalanceSnapshot,
  listRecentUsage,
  accountTotalEstimatedCost,
  getSetting,
  setSetting,
  listPrices,
  upsertPrice,
  type AccountRow,
  type RecentUsageRow,
  type PriceRow,
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
import BalanceChart from "../components/BalanceChart.vue";
import { testWebhook as testWebhookFn } from "../core/alert";
import { syncPricesIfNeeded } from "../core/platformSync";
import type { WebhookChannel } from "../core/webhook";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

type Tab = "accounts" | "usage" | "settings";

const tab = ref<Tab>("accounts");
const accounts = ref<AccountRow[]>([]);
const balances = ref<Record<number, { balance: number; currency: string; fetched_at: string }>>({});
const today = ref<{ input_tokens: number; output_tokens: number; cost: number; cost_estimated: number }>({
  input_tokens: 0,
  output_tokens: 0,
  cost: 0,
  cost_estimated: 0,
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

/** 显示消耗金额：余额差值有效用差值，否则回退 token×单价估算 */
function displayCost(cost: number, costEstimated: number): number {
  return cost > 0.0001 ? cost : costEstimated;
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
  // 聚合平台余额推算：充值余额 - 累计估算消耗
  for (const acc of accounts.value) {
    if (acc.provider_id === "siliconflow") {
      const cur = map[acc.id];
      if (cur) {
        const est = await accountTotalEstimatedCost(acc.id);
        cur.balance = Math.max(0, cur.balance - est);
      }
    }
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
    const { addAccount, deleteAccount } = await import("../core/db");
    const id = await addAccount(providerId, name);
    try {
      await invoke("save_secret", { account: String(id), secret: key });
    } catch (e) {
      // 密钥保存失败时回滚账户，避免留下无密钥的孤儿账户
      await deleteAccount(id);
      throw e;
    }
    if (provider?.balanceSupported) {
      const acc = (await listAccounts()).find((a) => a.id === id);
      if (acc) await collectAccount(acc);
    }
    formKey.value = "";
    formName.value = "";
    showToast(`已添加账户「${name}」`);
    await loadData();
  } catch (e) {
    showToast(`添加失败：${(e as Error).message || String(e)}`);
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
    if (result.failed > 0) {
      showToast(`刷新失败 ${result.failed} 个：\n${result.errors.slice(0, 3).join("\n")}`);
    } else {
      showToast(`刷新完成：成功 ${result.ok} 个`);
    }
  } catch (e) {
    showToast(`刷新失败：${(e as Error).message || String(e)}`);
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

// 手动登记余额
const showBalanceModal = ref(false);
const modalAccount = ref<AccountRow | null>(null);
const modalBalance = ref("");
const modalCurrency = ref("CNY");

function openBalanceModal(acc: AccountRow): void {
  modalAccount.value = acc;
  modalBalance.value = balances.value[acc.id] ? String(balances.value[acc.id].balance) : "";
  modalCurrency.value = balances.value[acc.id]?.currency ?? "CNY";
  showBalanceModal.value = true;
}

function closeBalanceModal(): void {
  showBalanceModal.value = false;
}

async function saveManualBalance(): Promise<void> {
  if (!modalAccount.value) return;
  const v = parseFloat(modalBalance.value);
  if (Number.isNaN(v) || v < 0) {
    showToast("请输入有效余额");
    return;
  }
  await saveBalanceSnapshot(modalAccount.value.id, {
    balance: v,
    currency: modalCurrency.value,
  });
  showToast("余额已登记");
  closeBalanceModal();
  await loadData();
}

// 用量展示
const recentUsage = ref<RecentUsageRow[]>([]);

async function loadUsage(): Promise<void> {
  recentUsage.value = await listRecentUsage(7);
}

function fmtTok(n: number): string {
  return n.toLocaleString("zh-CN");
}

// 余额趋势
const trendAccountId = ref<number | null>(null);
const trendRange = ref<"1" | "7" | "30" | "custom">("30");
const trendStartDate = ref("");

function trendDays(): number | undefined {
  if (trendRange.value === "custom") return undefined;
  return Number(trendRange.value);
}

function trendStart(): string | undefined {
  return trendRange.value === "custom" ? trendStartDate.value : undefined;
}

async function loadTrendAccount(): Promise<void> {
  const accs = await listAccounts();
  if (trendAccountId.value === null && accs.length > 0) {
    trendAccountId.value = accs[0].id;
  }
  // 自定义默认起始日期：30 天前
  if (!trendStartDate.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const pad = (n: number) => String(n).padStart(2, "0");
    trendStartDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

// 告警设置
const alertThreshold = ref("20");
const alertChannel = ref<WebhookChannel>("serverchan");
const alertWebhookUrl = ref("");

async function saveAlert(): Promise<void> {
  const t = parseFloat(alertThreshold.value);
  if (Number.isNaN(t) || t < 0) {
    showToast("请输入有效阈值");
    return;
  }
  await setSetting("alert_balance_threshold", String(t));
  await setSetting("alert_webhook_channel", alertChannel.value);
  await setSetting("alert_webhook_url", alertWebhookUrl.value.trim());
  showToast("告警设置已保存");
}

async function testWebhookSend(): Promise<void> {
  if (!alertWebhookUrl.value.trim()) {
    showToast("请先填写 Webhook URL");
    return;
  }
  try {
    await testWebhookFn(alertChannel.value, alertWebhookUrl.value.trim());
    showToast("测试消息已发送，请查看手机/群聊");
  } catch (e) {
    showToast(`发送失败：${(e as Error).message || String(e)}`);
  }
}

// 开机自启
const autostartOn = ref(false);
async function toggleAutostart(): Promise<void> {
  try {
    if (autostartOn.value) {
      await enableAutostart();
      showToast("已开启开机自启");
    } else {
      await disableAutostart();
      showToast("已关闭开机自启");
    }
  } catch (e) {
    autostartOn.value = !autostartOn.value;
    showToast(`操作失败：${(e as Error).message || String(e)}`);
  }
}

// 代理模式
const proxyAccountId = ref<number | null>(null);
const PROXY_ADDR = "http://127.0.0.1:8899/v1";

async function saveProxy(): Promise<void> {
  if (!proxyAccountId.value) {
    showToast("请选择记账账户");
    return;
  }
  await setSetting("proxy_account_id", String(proxyAccountId.value));
  showToast("代理设置已保存，token 将自动记录到该账户");
}

// 模型单价管理
const prices = ref<PriceRow[]>([]);
const priceProvider = ref("deepseek");
const priceModel = ref("");
const priceInput = ref("2");
const priceOutput = ref("3");
const priceCache = ref("0.2");

async function loadPrices(): Promise<void> {
  prices.value = await listPrices();
}

async function addPrice(): Promise<void> {
  const model = priceModel.value.trim();
  if (!model) {
    showToast("请填写模型名");
    return;
  }
  const input = parseFloat(priceInput.value);
  const output = parseFloat(priceOutput.value);
  const cache = parseFloat(priceCache.value);
  if ([input, output, cache].some((v) => Number.isNaN(v) || v < 0)) {
    showToast("请输入有效单价（元/百万 tokens）");
    return;
  }
  await upsertPrice({
    providerId: priceProvider.value,
    model,
    inputPrice: input,
    outputPrice: output,
    cacheHitPrice: cache,
  });
  showToast(`已保存 ${model} 单价`);
  priceModel.value = "";
  await loadPrices();
}

// 同步平台模型价格
const syncingPrices = ref(false);

async function syncPrices(): Promise<void> {
  if (syncingPrices.value) return;
  syncingPrices.value = true;
  try {
    const { synced, count } = await syncPricesIfNeeded(true);
    if (count > 0) {
      showToast(`已同步硅基流动 ${count} 个模型价格`);
    } else if (!synced) {
      showToast("同步失败或暂无更新");
    } else {
      showToast("价格无变化");
    }
    await loadPrices();
  } catch (e) {
    showToast(`同步失败：${(e as Error).message || String(e)}`);
  } finally {
    syncingPrices.value = false;
  }
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
  alertThreshold.value = (await getSetting("alert_balance_threshold")) ?? "20";
  alertChannel.value = ((await getSetting("alert_webhook_channel")) as WebhookChannel) ?? "serverchan";
  alertWebhookUrl.value = (await getSetting("alert_webhook_url")) ?? "";
  autostartOn.value = await isAutostartEnabled().catch(() => false);
  const proxySaved = await getSetting("proxy_account_id");
  proxyAccountId.value = proxySaved ? parseInt(proxySaved, 10) : (accounts.value[0]?.id ?? null);
  await loadPrices();
  await loadUsage();
  await loadTrendAccount();
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
            <div class="stat-value">{{ fmt(displayCost(today.cost, today.cost_estimated)) }} <span class="unit">¥</span></div>
          </div>
        </div>

        <div class="panel">
          <h3>余额趋势</h3>
          <div class="form-row">
            <select v-model="trendAccountId" class="input select">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                {{ acc.name }}
              </option>
            </select>
            <select v-model="trendRange" class="input select">
              <option value="1">近 1 日</option>
              <option value="7">近 7 日</option>
              <option value="30">近 30 日</option>
              <option value="custom">自定义</option>
            </select>
            <input
              v-if="trendRange === 'custom'"
              v-model="trendStartDate"
              class="input"
              type="date"
            />
          </div>
          <BalanceChart
            :account-id="trendAccountId"
            :days="trendDays()"
            :start-date="trendStart()"
          />
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
              <button
                v-if="!getProvider(acc.provider_id)?.balanceSupported"
                class="btn small"
                @click="openBalanceModal(acc)"
              >
                登记余额
              </button>
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
              <div class="usage-value">{{ fmtTok(today.input_tokens) }}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">输出 Tokens</div>
              <div class="usage-value">{{ fmtTok(today.output_tokens) }}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">估算费用</div>
              <div class="usage-value">¥{{ fmt(displayCost(today.cost, today.cost_estimated)) }}</div>
            </div>
          </div>
          <p class="hint">token 数据由统一代理自动记录；把调用地址指向 127.0.0.1:8899 即可。</p>
        </div>

        <div class="panel">
          <h3>最近 7 天记录</h3>
          <div v-if="recentUsage.length === 0" class="empty-tip">暂无用量记录</div>
          <table v-else class="usage-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>账户</th>
                <th>输入</th>
                <th>输出</th>
                <th>费用</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in recentUsage" :key="u.id">
                <td>{{ u.date }}</td>
                <td>{{ u.account_name }}</td>
                <td>{{ fmtTok(u.input_tokens) }}</td>
                <td>{{ fmtTok(u.output_tokens) }}</td>
                <td>¥{{ fmt(u.cost) }}</td>
                <td>{{ u.source === "manual" ? "手动" : u.source }}</td>
              </tr>
            </tbody>
          </table>
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
          <h3>余额告警</h3>
          <div class="form-row">
            <label class="form-label">余额低于（¥）触发通知</label>
            <input v-model="alertThreshold" class="input num" type="number" min="0" />
          </div>
          <div class="form-row">
            <label class="form-label">Webhook 渠道</label>
            <select v-model="alertChannel" class="input select">
              <option value="serverchan">Server酱</option>
              <option value="feishu">飞书机器人</option>
              <option value="dingtalk">钉钉机器人</option>
              <option value="bark">Bark (iOS)</option>
            </select>
          </div>
          <div class="form-row">
            <input v-model="alertWebhookUrl" class="input key" placeholder="Webhook URL（留空则仅系统通知）" />
            <button class="btn" @click="testWebhookSend">发送测试</button>
          </div>
          <div class="form-row">
            <button class="btn primary" @click="saveAlert">保存告警设置</button>
            <span class="hint-inline">系统通知始终开启；冷却 6 小时避免刷屏</span>
          </div>
        </div>
        <div class="panel">
          <h3>常规</h3>
          <div class="form-row">
            <label class="form-label">开机自动启动</label>
            <label class="switch">
              <input type="checkbox" v-model="autostartOn" @change="toggleAutostart" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="panel">
          <h3>统一代理（自动统计 Token）</h3>
          <p class="hint">
            代理服务已在本机运行。把<b>调用 AI 的程序</b>（代码 / SDK / 工具）的地址改为下面任意一个，每次调用自动记录 token。
          </p>
          <div class="code-block">
            {{ PROXY_ADDR }}<span class="code-note">（DeepSeek）</span><br />
            http://127.0.0.1:8899/moonshot/v1<span class="code-note">（Kimi）</span><br />
            http://127.0.0.1:8899/siliconflow/v1<span class="code-note">（硅基流动）</span>
          </div>
          <p class="hint">接入示例（Python）：</p>
          <div class="code-block">
            from openai import OpenAI<br />
            client = OpenAI(<br />
            &nbsp;&nbsp;api_key="你的真实key",<br />
            &nbsp;&nbsp;base_url="http://127.0.0.1:8899/v1",<br />
            )
          </div>
          <div class="form-row">
            <label class="form-label">Token 记入账户</label>
            <select v-model="proxyAccountId" class="input select">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                {{ acc.name }}
              </option>
            </select>
            <button class="btn primary" @click="saveProxy">保存</button>
          </div>
        </div>
        <div class="panel">
          <h3>模型单价（元/百万 tokens，用于金额统计）</h3>
          <table class="usage-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存命中</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in prices" :key="p.id">
                <td>{{ p.provider_id }}</td>
                <td>{{ p.model }}</td>
                <td>¥{{ p.input_price }}</td>
                <td>¥{{ p.output_price }}</td>
                <td>¥{{ p.cache_hit_price }}</td>
              </tr>
            </tbody>
          </table>
          <div class="form-row">
            <select v-model="priceProvider" class="input select">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <input v-model="priceModel" class="input" placeholder="模型名，如 deepseek-chat" />
            <input v-model="priceInput" class="input num" type="number" min="0" step="0.01" placeholder="输入" />
            <input v-model="priceOutput" class="input num" type="number" min="0" step="0.01" placeholder="输出" />
            <input v-model="priceCache" class="input num" type="number" min="0" step="0.01" placeholder="缓存" />
            <button class="btn primary" @click="addPrice">添加/更新</button>
          </div>
          <div class="form-row">
            <button class="btn" :disabled="syncingPrices" @click="syncPrices">
              {{ syncingPrices ? "同步中…" : "同步硅基流动全部价格" }}
            </button>
            <span class="hint-inline">自动抓取官网全部模型价格，每日更新</span>
          </div>
          <p class="hint">代理记账按此单价实时计算费用；硅基流动为聚合平台（一余额多模型），消耗按 token×单价 估算。</p>
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

    <!-- 手动登记余额 -->
    <div v-if="showBalanceModal" class="modal-mask" @click.self="closeBalanceModal">
      <div class="modal">
        <h3>登记余额</h3>
        <p class="hint">
          {{ modalAccount?.name }} · {{ getProvider(modalAccount?.provider_id ?? "")?.name }}
        </p>
        <div class="form-row">
          <input
            v-model="modalBalance"
            class="input num"
            type="number"
            step="0.01"
            min="0"
            placeholder="余额"
          />
          <select v-model="modalCurrency" class="input select">
            <option value="CNY">CNY</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="closeBalanceModal">取消</button>
          <button class="btn primary" @click="saveManualBalance">保存</button>
        </div>
      </div>
    </div>
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
}.usage-item {
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

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.usage-table th,
.usage-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-variant-numeric: tabular-nums;
}
.usage-table th {
  color: #9ca3af;
  font-weight: 500;
  font-size: 12px;
}
.usage-table tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}

.code-block {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #34d399;
  line-height: 1.8;
  margin-bottom: 12px;
}
.code-note {
  color: #6b7280;
  font-size: 11px;
}

.hint-inline {
  color: #6b7280;
  font-size: 12px;
  margin-left: 8px;
}

/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 42px;
  height: 24px;
  cursor: pointer;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 24px;
  transition: background 0.2s;
}
.slider::before {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.switch input:checked + .slider {
  background: #10b981;
}
.switch input:checked + .slider::before {
  transform: translateX(18px);
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
  max-width: 80vw;
  white-space: pre-line;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: #161a23;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 20px;
  width: 320px;
}
.modal h3 {
  margin: 0 0 6px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
