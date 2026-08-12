<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting, listPrices, upsertPrice, type PriceRow } from "../core/db";
import { getCollectIntervalMinutes, setCollectIntervalMinutes } from "../core/collector";
import { providers } from "../providers";
import { testWebhook as testWebhookFn } from "../core/alert";
import { syncPricesIfNeeded } from "../core/platformSync";
import type { WebhookChannel } from "../core/webhook";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { accounts, showToast } from "../core/dashboardStore";

const { t } = useI18n();

// 采集 & 低余额阈值
const intervalMinutes = ref(30);
const lowThreshold = ref("20");

async function saveInterval(): Promise<void> {
  const m = await setCollectIntervalMinutes(parseInt(String(intervalMinutes.value), 10) || 30);
  intervalMinutes.value = m;
  showToast(t("dashboard.toast.saveInterval", { m }));
}

async function saveThreshold(): Promise<void> {
  const v = parseInt(lowThreshold.value, 10);
  if (Number.isNaN(v) || v < 0) {
    showToast(t("dashboard.toast.invalidNumber"));
    return;
  }
  await setSetting("low_balance_threshold", String(v));
  showToast(t("dashboard.toast.saveThreshold", { v }));
}

// 告警设置（阈值与「低余额阈值」共用 low_balance_threshold）
const alertChannel = ref<WebhookChannel>("serverchan");
const alertWebhookUrl = ref("");

async function saveAlert(): Promise<void> {
  const threshold = parseFloat(lowThreshold.value);
  if (Number.isNaN(threshold) || threshold < 0) {
    showToast(t("dashboard.toast.addPriceInvalid"));
    return;
  }
  await setSetting("low_balance_threshold", String(lowThreshold.value));
  await setSetting("alert_webhook_channel", alertChannel.value);
  await setSetting("alert_webhook_url", alertWebhookUrl.value.trim());
  showToast(t("dashboard.toast.alertSaved"));
}

async function testWebhookSend(): Promise<void> {
  if (!alertWebhookUrl.value.trim()) {
    showToast(t("dashboard.toast.webhookEmpty"));
    return;
  }
  try {
    await testWebhookFn(alertChannel.value, alertWebhookUrl.value.trim());
    showToast(t("dashboard.toast.webhookSent"));
  } catch (e) {
    showToast(t("dashboard.toast.webhookFail", { err: (e as Error).message || String(e) }));
  }
}

// 开机自启
const autostartOn = ref(false);
async function toggleAutostart(): Promise<void> {
  try {
    if (autostartOn.value) {
      await enableAutostart();
      showToast(t("dashboard.toast.autostartOn"));
    } else {
      await disableAutostart();
      showToast(t("dashboard.toast.autostartOff"));
    }
  } catch (e) {
    autostartOn.value = !autostartOn.value;
    showToast(t("dashboard.toast.autostartFail", { err: (e as Error).message || String(e) }));
  }
}

// 代理模式
const proxyAccountId = ref<number | null>(null);
const PROXY_ADDR = "http://127.0.0.1:8899/v1";

async function saveProxy(): Promise<void> {
  if (!proxyAccountId.value) {
    showToast(t("dashboard.toast.proxyAccountRequired"));
    return;
  }
  await setSetting("proxy_account_id", String(proxyAccountId.value));
  showToast(t("dashboard.toast.saveProxyOk"));
}

// 代理访问密钥（x-proxy-secret）
const proxySecret = ref("");
const proxySecretEnabled = ref(false);
const savingProxySecret = ref(false);

async function saveProxySecret(): Promise<void> {
  if (savingProxySecret.value) return;
  savingProxySecret.value = true;
  try {
    await invoke("set_proxy_secret", { secret: proxySecret.value });
    proxySecretEnabled.value = proxySecret.value.trim().length > 0;
    proxySecret.value = "";
    showToast(
      proxySecretEnabled.value
        ? t("dashboard.toast.proxySecretOk")
        : t("dashboard.toast.proxySecretCleared")
    );
  } catch (e) {
    showToast((e as Error).message || String(e));
  } finally {
    savingProxySecret.value = false;
  }
}

async function clearProxySecret(): Promise<void> {
  try {
    await invoke("set_proxy_secret", { secret: "" });
    proxySecretEnabled.value = false;
    showToast(t("dashboard.toast.proxySecretCleared"));
  } catch (e) {
    showToast((e as Error).message || String(e));
  }
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
    showToast(t("dashboard.toast.addPriceNoModel"));
    return;
  }
  const input = parseFloat(priceInput.value);
  const output = parseFloat(priceOutput.value);
  const cache = parseFloat(priceCache.value);
  if ([input, output, cache].some((v) => Number.isNaN(v) || v < 0)) {
    showToast(t("dashboard.toast.addPriceInvalid"));
    return;
  }
  await upsertPrice({
    providerId: priceProvider.value,
    model,
    inputPrice: input,
    outputPrice: output,
    cacheHitPrice: cache,
  });
  showToast(t("dashboard.toast.priceOk", { model }));
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
      showToast(t("dashboard.toast.priceSyncOk", { count }));
    } else if (!synced) {
      showToast(t("dashboard.toast.priceSyncFail", { err: "" }));
    } else {
      showToast(t("dashboard.toast.priceSyncNone"));
    }
    await loadPrices();
  } catch (e) {
    showToast(t("dashboard.toast.priceSyncFail", { err: (e as Error).message || String(e) }));
  } finally {
    syncingPrices.value = false;
  }
}

// 自动更新
const checkingUpdate = ref(false);
const installing = ref(false);
const update = ref<Update | null>(null);

async function checkUpdates(): Promise<void> {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  update.value = null;
  try {
    const u = await checkForUpdate();
    if (u) {
      update.value = u;
      showToast(t("dashboard.toast.updateAvailable", { v: u.version }));
    } else {
      showToast(t("dashboard.toast.updateNone"));
    }
  } catch (e) {
    showToast(t("dashboard.toast.updateFail", { err: (e as Error).message || String(e) }));
  } finally {
    checkingUpdate.value = false;
  }
}

async function installUpdate(): Promise<void> {
  const u = update.value;
  if (!u || installing.value) return;
  installing.value = true;
  try {
    showToast(t("dashboard.toast.updateInstalling"));
    await u.downloadAndInstall();
  } catch (e) {
    showToast(t("dashboard.toast.updateInstallFail", { err: (e as Error).message || String(e) }));
  } finally {
    installing.value = false;
  }
}

onMounted(async () => {
  intervalMinutes.value = await getCollectIntervalMinutes();
  lowThreshold.value = (await getSetting("low_balance_threshold")) ?? "20";
  alertChannel.value =
    ((await getSetting("alert_webhook_channel")) as WebhookChannel) ?? "serverchan";
  alertWebhookUrl.value = (await getSetting("alert_webhook_url")) ?? "";
  autostartOn.value = await isAutostartEnabled().catch(() => false);
  const proxySaved = await getSetting("proxy_account_id");
  proxyAccountId.value = proxySaved ? parseInt(proxySaved, 10) : (accounts.value[0]?.id ?? null);
  proxySecretEnabled.value = !!(await getSetting("proxy_secret"));
  await loadPrices();
});
</script>

<template>
  <div>
    <div class="panel">
      <h3>{{ t("dashboard.settings.collectInterval") }}</h3>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.collectInterval") }}</label>
        <input
          v-model.number="intervalMinutes"
          class="input num"
          type="number"
          min="1"
          max="1440"
        />
        <button class="btn" @click="saveInterval">{{ t("dashboard.settings.save") }}</button>
      </div>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.lowBalanceThreshold") }}</label>
        <input v-model="lowThreshold" class="input num" type="number" min="0" />
        <button class="btn" @click="saveThreshold">{{ t("dashboard.settings.save") }}</button>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.settings.alertTitle") }}</h3>
      <div class="form-row">
        <span class="form-label">{{ t("dashboard.settings.alertThreshold") }}</span>
        <span class="hint-inline">{{ t("dashboard.settings.alertThresholdHint") }}</span>
      </div>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.webhookChannel") }}</label>
        <select v-model="alertChannel" class="input select">
          <option value="serverchan">ServerChan</option>
          <option value="feishu">Feishu</option>
          <option value="dingtalk">DingTalk</option>
          <option value="bark">Bark</option>
        </select>
      </div>
      <div class="form-row">
        <input
          v-model="alertWebhookUrl"
          class="input key"
          :placeholder="t('dashboard.settings.webhookUrl')"
        />
        <button class="btn" @click="testWebhookSend">{{ t("dashboard.settings.sendTest") }}</button>
      </div>
      <div class="form-row">
        <button class="btn primary" @click="saveAlert">
          {{ t("dashboard.settings.saveAlert") }}
        </button>
        <span class="hint-inline">{{ t("dashboard.settings.alertHint") }}</span>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.settings.autostart") }}</h3>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.autostart") }}</label>
        <label class="switch">
          <input v-model="autostartOn" type="checkbox" @change="toggleAutostart" />
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.settings.proxy") }}</h3>
      <p class="hint">{{ t("dashboard.settings.proxyHint") }}</p>
      <div class="code-block">
        {{ PROXY_ADDR }}<span class="code-note">（DeepSeek）</span><br />
        http://127.0.0.1:8899/moonshot/v1<span class="code-note">（Kimi）</span><br />
        http://127.0.0.1:8899/siliconflow/v1<span class="code-note">（SiliconFlow）</span>
      </div>
      <p class="hint">Python:</p>
      <div class="code-block">
        from openai import OpenAI<br />
        client = OpenAI(<br />
        &nbsp;&nbsp;api_key="sk-your-key",<br />
        &nbsp;&nbsp;base_url="http://127.0.0.1:8899/v1",<br />
        )
      </div>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.proxyAccount") }}</label>
        <select v-model="proxyAccountId" class="input select">
          <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }}</option>
        </select>
        <button class="btn primary" @click="saveProxy">
          {{ t("dashboard.settings.saveProxy") }}
        </button>
      </div>
      <p class="hint">{{ t("dashboard.settings.proxySecretHint") }}</p>
      <div class="form-row">
        <label class="form-label">{{ t("dashboard.settings.proxySecret") }}</label>
        <input
          v-model="proxySecret"
          class="input key"
          type="password"
          autocomplete="new-password"
          :placeholder="proxySecretEnabled ? t('dashboard.settings.proxySecretEnabled') : t('dashboard.settings.proxySecretDisabled')"
        />
        <button class="btn primary" :disabled="savingProxySecret" @click="saveProxySecret">
          {{ t("dashboard.settings.saveSecret") }}
        </button>
        <button v-if="proxySecretEnabled" class="btn" @click="clearProxySecret">
          {{ t("dashboard.settings.clearSecret") }}
        </button>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.settings.priceTitle") }}</h3>
      <table class="usage-table">
        <thead>
          <tr>
            <th>Platform</th>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache</th>
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
        <input
          v-model="priceModel"
          class="input"
          :placeholder="t('dashboard.settings.modelName')"
        />
        <input
          v-model="priceInput"
          class="input num"
          type="number"
          min="0"
          step="0.01"
          :placeholder="t('dashboard.settings.input')"
        />
        <input
          v-model="priceOutput"
          class="input num"
          type="number"
          min="0"
          step="0.01"
          :placeholder="t('dashboard.settings.output')"
        />
        <input
          v-model="priceCache"
          class="input num"
          type="number"
          min="0"
          step="0.01"
          :placeholder="t('dashboard.settings.cache')"
        />
        <button class="btn primary" @click="addPrice">
          {{ t("dashboard.settings.addUpdate") }}
        </button>
      </div>
      <div class="form-row">
        <button class="btn" :disabled="syncingPrices" @click="syncPrices">
          {{ syncingPrices ? t("dashboard.adding") : t("dashboard.settings.priceSync") }}
        </button>
        <span class="hint-inline">{{ t("dashboard.settings.priceSyncHint") }}</span>
      </div>
      <p class="hint">{{ t("dashboard.settings.priceHint") }}</p>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.settings.about") }}</h3>
      <p class="hint" style="white-space: pre-line">{{ t("dashboard.settings.aboutText") }}</p>
      <div class="form-row">
        <button class="btn" :disabled="checkingUpdate || installing" @click="checkUpdates">
          {{ checkingUpdate ? t("dashboard.settings.updateChecking") : t("dashboard.settings.updateCheck") }}
        </button>
        <button
          v-if="update && !installing"
          class="btn primary"
          @click="installUpdate"
        >
          {{ t("dashboard.settings.updateInstall") }}
        </button>
        <span v-if="installing" class="hint-inline">
          {{ t("dashboard.settings.updateInstallingNow") }}
        </span>
        <span v-if="update" class="hint-inline">v{{ update.version }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.panel h3 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--c-text-secondary);
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
  color: var(--c-text-dim);
  font-size: 13px;
}

.input {
  background: var(--c-border);
  border: 1px solid var(--c-border-strong);
  border-radius: 8px;
  color: var(--c-text);
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
}
.input:focus {
  border-color: var(--c-accent-strong);
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
  background: var(--c-border-strong);
  border: 1px solid var(--c-border-strong);
  color: var(--c-text);
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
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: #fff;
}
.btn.primary:hover {
  background: var(--c-accent-strong);
}

.hint {
  color: var(--c-text-faint);
  font-size: 12px;
  margin: 6px 0 0;
  line-height: 1.7;
}
.hint-inline {
  color: var(--c-text-faint);
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
  background: var(--c-accent);
}
.switch input:checked + .slider::before {
  transform: translateX(18px);
}

.code-block {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--c-border-strong);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--c-accent-strong);
  line-height: 1.8;
  margin-bottom: 12px;
}
.code-note {
  color: var(--c-text-faint);
  font-size: 11px;
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
  border-bottom: 1px solid var(--c-border);
  font-variant-numeric: tabular-nums;
}
.usage-table th {
  color: var(--c-text-dim);
  font-weight: 500;
  font-size: 12px;
}
.usage-table tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}
</style>
