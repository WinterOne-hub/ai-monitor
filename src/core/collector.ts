import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  listAccounts,
  saveBalanceSnapshot,
  getSetting,
  setSetting,
  type AccountRow,
  type BalanceInfo,
} from "./db";
import { getProvider } from "../providers";
import { checkAlerts } from "./alert";
import { getDb } from "./db";

/**
 * 用余额差值同步每日真实消耗：
 * 每天首条余额快照 - 当天最后一条 = 当天实际扣费（充值会使差值失真，忽略负值）
 * 结果写入 daily_usage.cost（权威值）；token×单价估算在 cost_estimated（备用）
 */
export async function syncCostFromBalance(): Promise<void> {
  try {
    const d = getDb();
    // 每天每条余额快照（含日期）
    const rows = await d.select<{ account_id: number; balance: number; fetched_at: string; day: string }[]>(
      `SELECT account_id, balance, fetched_at, substr(fetched_at, 1, 10) AS day
       FROM balance_snapshots
       ORDER BY account_id, fetched_at ASC`
    );
    // 按账户+天分组，取首末
    const byAcc: Record<number, { day: string; first: number; last: number }[]> = {};
    for (const r of rows) {
      const arr = (byAcc[r.account_id] ??= []);
      const found = arr.find((x) => x.day === r.day);
      if (found) {
        found.last = r.balance;
      } else {
        arr.push({ day: r.day, first: r.balance, last: r.balance });
      }
    }
    for (const [accIdStr, days] of Object.entries(byAcc)) {
      const accId = Number(accIdStr);
      for (const dayInfo of days) {
        const diff = dayInfo.first - dayInfo.last; // 正 = 消耗
        if (diff > 0.0001) {
          await d.execute(
            `INSERT INTO daily_usage (account_id, date, cost, source)
             VALUES ($1, $2, $3, 'balance')
             ON CONFLICT(account_id, date) DO UPDATE SET cost = excluded.cost, source = 'balance'`,
            [accId, dayInfo.day, diff]
          );
        }
      }
    }
  } catch (e) {
    console.error("余额差值计费同步失败", e);
  }
}

export const EVENT_BALANCE_UPDATED = "balance-updated";
export const EVENT_COLLECT_START = "collect-start";
export const EVENT_COLLECT_END = "collect-end";

/** 单账户采集：调平台接口拿余额 → 落库 */
export async function collectAccount(account: AccountRow): Promise<BalanceInfo> {
  const provider = getProvider(account.provider_id);
  if (!provider || !provider.balanceSupported) {
    throw new Error(`${account.name}（${account.provider_id}）暂不支持自动查询余额`);
  }
  const apiKey = await invoke<string>("get_secret", { account: String(account.id) });
  const info = await provider.getBalance(apiKey);
  await saveBalanceSnapshot(account.id, info);
  return info;
}

/** 全量采集（跳过未启用/不支持自动查询的账户） */
export async function collectAll(): Promise<{ ok: number; failed: number; errors: string[] }> {
  await emit(EVENT_COLLECT_START);
  const accounts = await listAccounts();
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    if (!account.enabled) continue;
    const provider = getProvider(account.provider_id);
    if (!provider?.balanceSupported) continue;
    try {
      await collectAccount(account);
      ok++;
    } catch (e) {
      failed++;
      errors.push(`${account.name}: ${(e as Error).message || String(e)}`);
    }
  }

  if (ok > 0) {
    await setSetting("last_collect_at", new Date().toISOString());
  }
  await emit(EVENT_COLLECT_END, { ok, failed, errors });
  await emit(EVENT_BALANCE_UPDATED);
  await checkAlerts();
  await syncCostFromBalance();
  await emit(EVENT_BALANCE_UPDATED);
  return { ok, failed, errors };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** 启动定时采集（应在常驻的 overlay 窗口调用） */
export function startAutoCollect(): void {
  if (timer) return;
  const run = async () => {
    try {
      await collectAll();
    } catch (e) {
      console.error("自动采集失败", e);
    }
  };
  void run();
  timer = setInterval(run, 30 * 60 * 1000); // 默认 30 分钟
}

/** 读取并调整采集间隔（分钟），返回当前生效间隔 */
export async function setCollectIntervalMinutes(minutes: number): Promise<number> {
  const safe = Math.min(1440, Math.max(1, Math.floor(minutes)));
  await setSetting("collect_interval_minutes", String(safe));
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  startAutoCollect();
  return safe;
}

export async function getCollectIntervalMinutes(): Promise<number> {
  const v = await getSetting("collect_interval_minutes");
  return v ? parseInt(v, 10) : 30;
}

/** 删除账户时同时清理系统钥匙串中的密钥 */
export async function deleteAccountAndSecret(accountId: number): Promise<void> {
  const { deleteAccount } = await import("./db");
  try {
    await invoke("delete_secret", { account: String(accountId) });
  } catch {
    // 密钥不存在时忽略
  }
  await deleteAccount(accountId);
}
