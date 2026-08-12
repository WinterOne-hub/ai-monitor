import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  initDb,
  listAccounts,
  latestBalances,
  todayUsageTotal,
  todayUsageByAccount,
  accountTotalEstimatedCost,
  type AccountRow,
} from "../core/db";
import { collectAll } from "../core/collector";

/**
 * Dashboard 共享数据存储（单例）
 * Overlay/Dashboard 各视图通过 useDashboard() 共享同一份账户/余额/今日数据。
 */
export interface BalanceEntry {
  balance: number;
  currency: string;
  fetched_at: string;
}

const accounts = ref<AccountRow[]>([]);
const balances = ref<Record<number, BalanceEntry>>({});
const today = ref<{
  input_tokens: number;
  output_tokens: number;
  cost: number;
  cost_estimated: number;
}>({
  input_tokens: 0,
  output_tokens: 0,
  cost: 0,
  cost_estimated: 0,
});
const todayByAccount = ref<
  Record<
    number,
    { input_tokens: number; output_tokens: number; cost: number; cost_estimated: number }
  >
>({});
const collecting = ref(false);
const toast = ref("");
const lastErrors = ref<string[]>([]);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

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

export async function ensureData(): Promise<void> {
  await initDb();
  await loadData();
}

export async function loadData(): Promise<void> {
  accounts.value = await listAccounts();
  const lbs = await latestBalances();
  const map: Record<number, BalanceEntry> = {};
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
  const byAcc = await todayUsageByAccount();
  const accMap: Record<
    number,
    { input_tokens: number; output_tokens: number; cost: number; cost_estimated: number }
  > = {};
  for (const u of byAcc) {
    accMap[u.account_id] = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cost: u.cost,
      cost_estimated: u.cost_estimated,
    };
  }
  todayByAccount.value = accMap;
  // 同步托盘标题（macOS 菜单栏）
  void invoke("set_tray_status", {
    total: totalBalance.value.toFixed(2),
    today: displayCost(today.value.cost, today.value.cost_estimated).toFixed(2),
  }).catch(() => null);
}

export async function refreshAll(): Promise<{ ok: number; failed: number; errors: string[] }> {
  if (collecting.value) return { ok: 0, failed: 0, errors: [] };
  collecting.value = true;
  try {
    const result = await collectAll();
    await loadData();
    lastErrors.value = result.errors;
    return result;
  } finally {
    collecting.value = false;
  }
}

export {
  accounts,
  balances,
  today,
  todayByAccount,
  collecting,
  toast,
  lastErrors,
  totalBalance,
  showToast,
  fmt,
  displayCost,
};
