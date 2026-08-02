import { listAccounts, latestBalances, getSetting, setSetting } from "./db";
import { notify } from "./notify";
import { sendWebhook, type WebhookChannel } from "./webhook";

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 告警冷却 6 小时

/**
 * 采集后检查余额告警：
 * - 任一账户余额低于阈值 -> 系统通知 + Webhook
 * - 冷却期内不重复告警；余额恢复后重置冷却
 */
export async function checkAlerts(): Promise<void> {
  try {
    const threshold = parseFloat((await getSetting("alert_balance_threshold")) ?? "20");
    if (Number.isNaN(threshold)) return;

    const accounts = await listAccounts();
    const balances = await latestBalances();

    const lowOnes = accounts.filter((a) => {
      const b = balances.find((x) => x.account_id === a.id);
      return b !== undefined && b.balance < threshold;
    });

    const lastRaw = await getSetting("alert_last_ts");
    const lastAt = lastRaw ? new Date(lastRaw).getTime() : 0;

    if (lowOnes.length === 0) {
      // 余额恢复，重置冷却
      await setSetting("alert_last_ts", "");
      return;
    }
    if (Date.now() - lastAt < COOLDOWN_MS) return;

    const names = lowOnes.map((a) => a.name).join("、");
    const title = "⚠️ AI 账户余额不足";
    const body = `${names} 余额低于 ¥${threshold}，请及时充值`;

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
  } catch (e) {
    console.error("余额告警检查失败", e);
  }
}

/** 手动测试 Webhook（设置页用） */
export async function testWebhook(channel: WebhookChannel, url: string): Promise<void> {
  await sendWebhook(channel, url, "AI 用量监控 · 测试", "这是来自 AI 用量监控的测试消息 ✅");
}
