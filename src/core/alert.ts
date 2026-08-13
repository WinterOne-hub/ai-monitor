import { listAccounts, latestBalances, getSetting, setSetting } from "./db";
import { notify } from "./notify";
import { sendWebhook, type WebhookChannel } from "./webhook";

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 告警冷却 6 小时
// 冷却期内余额继续下降的提醒阈值：低于上次告警余额的百分比
const COOLDOWN_DROP_RATIO = 0.5; // 再降 50% 提前提醒

/**
 * 采集后检查余额告警：
 * - 任一账户余额低于阈值 -> 系统通知 + Webhook
 * - 冷却期内不重复告警；余额恢复后重置冷却
 * - 冷却期内若余额显著低于上次告警时的余额，提前再次提醒（余额持续下跌要让人知道）
 */
export async function checkAlerts(): Promise<void> {
  try {
    // 单一阈值来源 low_balance_threshold；兼容旧 key alert_balance_threshold
    const threshold = parseFloat(
      (await getSetting("low_balance_threshold")) ??
        (await getSetting("alert_balance_threshold")) ??
        "20"
    );
    if (Number.isNaN(threshold)) return;

    const accounts = await listAccounts();
    const balances = await latestBalances();

    const lowOnes = accounts.filter((a) => {
      const b = balances.find((x) => x.account_id === a.id);
      return b !== undefined && b.balance < threshold;
    });

    const lastRaw = await getSetting("alert_last_ts");
    const lastAt = lastRaw ? new Date(lastRaw).getTime() : 0;
    // 上次告警时的最低余额（用于冷却期内检测继续下跌）
    const lastLowRaw = await getSetting("alert_last_low_balance");
    const lastLow = lastLowRaw ? parseFloat(lastLowRaw) : NaN;
    const currentLow = lowOnes.length > 0 ? Math.min(...lowOnes.map((a) => {
      const b = balances.find((x) => x.account_id === a.id);
      return b ? b.balance : Number.POSITIVE_INFINITY;
    })) : Number.POSITIVE_INFINITY;

    if (lowOnes.length === 0) {
      // 余额恢复，重置冷却
      await setSetting("alert_last_ts", "");
      await setSetting("alert_last_low_balance", "");
      return;
    }

    const inCooldown = Date.now() - lastAt < COOLDOWN_MS;
    const droppedMore = !Number.isNaN(lastLow) && currentLow < lastLow * COOLDOWN_DROP_RATIO;
    if (inCooldown && !droppedMore) return;

    const names = lowOnes.map((a) => a.name).join("、");
    const title = "⚠️ AI 账户余额不足";
    const body = `${names} 余额低于 ¥${threshold}${droppedMore ? `，且较上次告警进一步下降（现最低 ¥${currentLow.toFixed(2)}）` : ""}，请及时充值`;

    // 系统通知
    await notify(title, body);

    // Webhook 通知
    const url = await getSetting("alert_webhook_url");
    const channelRaw = await getSetting("alert_webhook_channel");
    if (url) {
      const channel = (channelRaw as WebhookChannel) || "serverchan";
      try {
        await sendWebhook(channel, url, title, body);
      } catch (e) {
        console.error("Webhook 发送失败", e);
      }
    }

    await setSetting("alert_last_ts", new Date().toISOString());
    if (!Number.isNaN(currentLow) && Number.isFinite(currentLow)) {
      await setSetting("alert_last_low_balance", String(currentLow));
    }
  } catch (e) {
    console.error("余额告警检查失败", e);
  }
}

/** 手动测试 Webhook（设置页用） */
export async function testWebhook(channel: WebhookChannel, url: string): Promise<void> {
  await sendWebhook(channel, url, "AI 用量监控 · 测试", "这是来自 AI 用量监控的测试消息 ✅");
}
