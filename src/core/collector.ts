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
      errors.push(`${account.name}: ${(e as Error).message}`);
    }
  }

  if (ok > 0) {
    await setSetting("last_collect_at", new Date().toISOString());
  }
  await emit(EVENT_COLLECT_END, { ok, failed, errors });
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
