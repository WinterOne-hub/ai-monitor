<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  saveBalanceSnapshot,
  getSetting,
  addAccount as dbAddAccount,
  deleteAccount as dbDeleteAccount,
} from "../core/db";
import { collectAccount, deleteAccountAndSecret } from "../core/collector";
import { providers, getProvider } from "../providers";
import BalanceChart from "./BalanceChart.vue";
import { i18n } from "../i18n";
import {
  accounts,
  balances,
  today,
  totalBalance,
  fmt,
  displayCost,
  loadData,
  showToast,
} from "../core/dashboardStore";

const { t } = useI18n();
const isZh = () => i18n.global.locale.value === "zh";

const lowThreshold = ref(20);

// 添加表单
const formProvider = ref("deepseek");
const formName = ref("");
const formKey = ref("");
const adding = ref(false);

async function addAccount(): Promise<void> {
  const providerId = formProvider.value;
  const provider = getProvider(providerId);
  const name = formName.value.trim() || provider?.name || providerId;
  const key = formKey.value.trim();
  if (!key) {
    showToast(t("dashboard.toast.apiKeyRequired"));
    return;
  }
  adding.value = true;
  try {
    const id = await dbAddAccount(providerId, name);
    try {
      await invoke("save_secret", { account: String(id), secret: key });
    } catch (e) {
      await dbDeleteAccount(id);
      throw e;
    }
    if (provider?.balanceSupported) {
      const acc = accounts.value.find((a) => a.id === id);
      if (acc) await collectAccount(acc);
    }
    formKey.value = "";
    formName.value = "";
    showToast(t("dashboard.toast.addOk", { name }));
    await loadData();
  } catch (e) {
    showToast(t("dashboard.toast.addFail", { err: (e as Error).message || String(e) }));
  } finally {
    adding.value = false;
  }
}

async function removeAccount(accId: number, accName: string): Promise<void> {
  await deleteAccountAndSecret(accId);
  showToast(t("dashboard.toast.delOk", { name: accName }));
  await loadData();
}

async function refreshOne(accId: number, accName: string): Promise<void> {
  const acc = accounts.value.find((a) => a.id === accId);
  if (!acc) return;
  try {
    await collectAccount(acc);
    showToast(t("dashboard.toast.refreshOneOk", { name: accName }));
  } catch (e) {
    showToast(t("dashboard.toast.refreshOneFail", { err: (e as Error).message }));
  }
  await loadData();
}

const showBalanceModal = ref(false);
const modalAccount = ref<number | null>(null);
const modalBalance = ref("");
const modalCurrency = ref("CNY");

function openBalanceModal(accId: number): void {
  modalAccount.value = accId;
  const cur = balances.value[accId];
  modalBalance.value = cur ? String(cur.balance) : "";
  modalCurrency.value = cur?.currency ?? "CNY";
  showBalanceModal.value = true;
}

function closeBalanceModal(): void {
  showBalanceModal.value = false;
}

async function saveManualBalance(): Promise<void> {
  if (modalAccount.value === null) return;
  const v = parseFloat(modalBalance.value);
  if (Number.isNaN(v) || v < 0) {
    showToast(t("dashboard.toast.balanceInvalid"));
    return;
  }
  await saveBalanceSnapshot(modalAccount.value, { balance: v, currency: modalCurrency.value });
  showToast(t("dashboard.toast.balanceRegistered"));
  closeBalanceModal();
  await loadData();
}

// 余额趋势
const trendAccountId = ref<number | null>(null);
const trendRange = ref<"1" | "7" | "30" | "custom">("1");
const trendStartDate = ref("");
const trendEndDate = ref("");
const trendMinDate = "2010-01-01";

function trendMaxDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function trendDays(): number | undefined {
  if (trendRange.value === "custom") return undefined;
  return Number(trendRange.value);
}

function trendStart(): string | undefined {
  return trendRange.value === "custom" ? trendStartDate.value : undefined;
}

function trendEnd(): string | undefined {
  return trendRange.value === "custom" ? trendEndDate.value : undefined;
}

onMounted(async () => {
  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  // 默认账户与自定义日期范围
  if (trendAccountId.value === null && accounts.value.length > 0) {
    trendAccountId.value = accounts.value[0].id;
  }
  if (!trendStartDate.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const pad = (n: number) => String(n).padStart(2, "0");
    trendStartDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (!trendEndDate.value) {
    trendEndDate.value = trendMaxDate();
  }
});
</script>

<template>
  <div>
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statTotal") }}</div>
        <div class="stat-value">{{ accounts.length }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statBalance") }}</div>
        <div class="stat-value">{{ fmt(totalBalance) }} <span class="unit">¥</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statToday") }}</div>
        <div class="stat-value">
          {{ fmt(displayCost(today.cost, today.cost_estimated)) }} <span class="unit">¥</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.trend") }}</h3>
      <div class="form-row">
        <select v-model="trendAccountId" class="input select">
          <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }}</option>
        </select>
        <select v-model="trendRange" class="input select">
          <option value="1">{{ t("dashboard.trendRange.1") }}</option>
          <option value="7">{{ t("dashboard.trendRange.7") }}</option>
          <option value="30">{{ t("dashboard.trendRange.30") }}</option>
          <option value="custom">{{ t("dashboard.trendRange.custom") }}</option>
        </select>
        <input
          v-if="trendRange === 'custom'"
          v-model="trendStartDate"
          class="input"
          type="date"
          :min="trendMinDate"
          :max="trendMaxDate()"
        />
        <span v-if="trendRange === 'custom'">→</span>
        <input
          v-if="trendRange === 'custom'"
          v-model="trendEndDate"
          class="input"
          type="date"
          :min="trendMinDate"
          :max="trendMaxDate()"
        />
      </div>
      <BalanceChart
        :account-id="trendAccountId"
        :days="trendDays()"
        :start-date="trendStart()"
        :end-date="trendEnd()"
      />
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.addAccount") }}</h3>
      <div class="form-row">
        <select v-model="formProvider" class="input select">
          <option v-for="p in providers" :key="p.id" :value="p.id">
            {{ p.name }}{{ p.balanceSupported ? "" : "（" + t("dashboard.registerBalance") + "）" }}
          </option>
        </select>
        <input v-model="formName" class="input" :placeholder="t('dashboard.accountName')" />
        <input
          v-model="formKey"
          class="input key"
          type="password"
          :placeholder="t('dashboard.apiKey')"
        />
        <button class="btn primary" :disabled="adding" @click="addAccount">
          {{ adding ? t("dashboard.adding") : t("dashboard.add") }}
        </button>
      </div>
      <p v-if="!getProvider(formProvider)?.balanceSupported" class="hint">
        {{ t("dashboard.manualHint") }}
      </p>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.accountList") }}</h3>
      <div v-if="accounts.length === 0" class="empty-tip">{{ t("dashboard.noAccounts") }}</div>
      <div v-for="acc in accounts" :key="acc.id" class="acc-card">
        <div class="acc-info">
          <div class="acc-name">{{ acc.name }}</div>
          <div class="acc-sub">
            {{ getProvider(acc.provider_id)?.name ?? acc.provider_id }}
            <template v-if="balances[acc.id]">
              · {{ t("dashboard.updateAt") }}
              {{
                new Date(balances[acc.id].fetched_at.replace(" ", "T")).toLocaleString(
                  isZh() ? "zh-CN" : "en-US"
                )
              }}
            </template>
          </div>
        </div>
        <div class="acc-balance">
          <div class="bal-num">{{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}</div>
          <div class="bal-cur">{{ balances[acc.id]?.currency ?? "" }}</div>
        </div>
        <div class="acc-actions">
          <button class="btn small" @click="refreshOne(acc.id, acc.name)">
            {{ t("dashboard.refresh") }}
          </button>
          <button
            v-if="!getProvider(acc.provider_id)?.balanceSupported"
            class="btn small"
            @click="openBalanceModal(acc.id)"
          >
            {{ t("dashboard.registerBalance") }}
          </button>
          <button class="btn small danger" @click="removeAccount(acc.id, acc.name)">
            {{ t("dashboard.delete") }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showBalanceModal" class="modal-mask" @click.self="closeBalanceModal">
      <div class="modal">
        <h3>{{ t("dashboard.registerBalance") }}</h3>
        <p class="hint">
          {{
            balances[modalAccount ?? -1]
              ? getProvider(accounts.find((a) => a.id === modalAccount)?.provider_id ?? "")?.name
              : ""
          }}
        </p>
        <div class="form-row">
          <input
            v-model="modalBalance"
            class="input num"
            type="number"
            step="0.01"
            min="0"
            :placeholder="t('dashboard.registerBalance')"
          />
          <select v-model="modalCurrency" class="input select">
            <option value="CNY">CNY</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="closeBalanceModal">{{ t("dashboard.cancel") }}</button>
          <button class="btn primary" @click="saveManualBalance">
            {{ t("dashboard.settings.save") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 14px 16px;
}
.stat-label {
  color: var(--c-text-dim);
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
  color: var(--c-text-dim);
  font-weight: 400;
}

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
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.btn.danger {
  color: var(--c-danger);
  border-color: rgba(248, 113, 113, 0.3);
}
.btn.danger:hover {
  background: rgba(248, 113, 113, 0.12);
}

.hint {
  color: var(--c-text-faint);
  font-size: 12px;
  margin: 6px 0 0;
  line-height: 1.7;
}
.empty-tip {
  color: var(--c-text-faint);
  padding: 20px;
  text-align: center;
}

.acc-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
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
  color: var(--c-text-faint);
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
  color: var(--c-text-faint);
}
.acc-actions {
  display: flex;
  gap: 6px;
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
  border: 1px solid var(--c-border-strong);
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
