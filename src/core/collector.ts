import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  listAccounts,
  saveBalanceSnapshot,
  getSetting,
  setSetting,
  deleteAccount,
  getDb,
  type AccountRow,
  type BalanceInfo,
} from "./db";
import { getProvider } from "../providers";
import { checkAlerts } from "./alert";
import { syncPricesIfNeeded } from "./platformSync";

/**
 * 用余额差值同步每日真实消耗：
 * 每天首条余额快照 - 当天最后一条 = 当天实际扣费（充值会使差值失真，忽略负值）
 * 结果写入 daily_usage.cost（权威值）；token×单价估算在 cost_estimated（备用）
 */
export async function syncCostFromBalance(): Promise<void> {
  try {
    const d = getDb();
    // 每天每条余额快照（含日期）；只扫近 45 天，避免全表读入 JS
    const rows = await d.select<
      { account_id: number; balance: number; fetched_at: string; day: string }[]
    >(
      `SELECT account_id, balance, fetched_at, substr(fetched_at, 1, 10) AS day
       FROM balance_snapshots
       WHERE fetched_at >= datetime('now', 'localtime', '-45 days')
       ORDER BY account_id, fetched_at ASC`
    );
    // 代理已逐笔记账（source='proxy' 带权威 cost）的日期不可被余额差值覆盖
    const proxyDays = await d.select<{ account_id: number; date: string }[]>(
      `SELECT DISTINCT account_id, date FROM daily_usage
       WHERE source = 'proxy' AND cost > 0.0001
         AND date >= date('now', 'localtime', '-45 days')`
    );
    const proxySet = new Set(proxyDays.map((p) => `${p.account_id}|${p.date}`));

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
        // 该日已有代理记账的真实消耗，保留代理值
        if (proxySet.has(`${accId}|${dayInfo.day}`)) continue;
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
  // 每日自动同步平台模型价格（硅基流动等，节流 24h）
  await syncPricesIfNeeded().catch(() => {});
  return { ok, failed, errors };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let scheduled = false; // 防止 async schedule 竞态导致重复定时器

/**
 * 启动定时采集。
 * 面板窗口与悬浮窗都会调用，但二者共享同一 SQLite 里的 last_collect_at，
 * 因此用「距上次采集是否超过间隔」做去重：先触发者写回时间戳，另一个窗口跳过本轮，
 * 保证任意窗口常驻时都会按时采集（全局单例采集）。
 *
 * 用递归 setTimeout 而非固定 setInterval：每次触发前重新读取 collect_interval_minutes，
 * 使修改间隔设置后无需重启窗口即可生效（v0.1.4 之前写死 30 分钟，导致 1 分钟间隔不生效）。
 */
export function startAutoCollect(): void {
  if (timer || scheduled) return;
  scheduled = true;
  const schedule = async () => {
    // 若已被 stop/setInterval 清理，不再自我续期
    if (!scheduled) return;
    const intervalMs = (await getCollectIntervalMinutes()) * 60 * 1000;
    if (!scheduled) return; // 等待读取期间被停止
    timer = setTimeout(run, intervalMs);
  };
  const run = async () => {
    try {
      const intervalMs = (await getCollectIntervalMinutes()) * 60 * 1000;
      const lastStr = await getSetting("last_collect_at");
      const lastTs = lastStr ? new Date(lastStr).getTime() : 0;
      if (Date.now() - lastTs < intervalMs - 10_000) return; // 已由另一窗口/实例采集
      await collectAll();
    } catch (e) {
      console.error("自动采集失败", e);
    } finally {
      void schedule();
    }
  };
  void schedule();
}

/** 读取并调整采集间隔（分钟），返回当前生效间隔 */
export async function setCollectIntervalMinutes(minutes: number): Promise<number> {
  const safe = Math.min(1440, Math.max(1, Math.floor(minutes)));
  await setSetting("collect_interval_minutes", String(safe));
  // 停止旧定时器并重新调度（scheduled 标记保证不产生双定时器）
  stopAutoCollect();
  startAutoCollect();
  return safe;
}

/** 停止自动采集（仅供内部重调度使用） */
function stopAutoCollect(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  scheduled = false;
}

export async function getCollectIntervalMinutes(): Promise<number> {
  const v = await getSetting("collect_interval_minutes");
  return v ? parseInt(v, 10) : 30;
}

/** 删除账户时同时清理系统钥匙串中的密钥 */
export async function deleteAccountAndSecret(accountId: number): Promise<void> {
  try {
    await invoke("delete_secret", { account: String(accountId) });
  } catch {
    // 密钥不存在时忽略
  }
  await deleteAccount(accountId);
}
