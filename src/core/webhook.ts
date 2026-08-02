import { invoke } from "@tauri-apps/api/core";

/** 通过 Rust 侧发送 HTTP POST（规避 CORS） */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<unknown> {
  return invoke("http_post_json", {
    url,
    headers: Object.entries(headers),
    body,
  });
}

export type WebhookChannel = "serverchan" | "feishu" | "dingtalk" | "bark";

/**
 * 按渠道发送告警消息到 Webhook
 */
export async function sendWebhook(
  channel: WebhookChannel,
  url: string,
  title: string,
  content: string
): Promise<void> {
  if (!url) return;
  switch (channel) {
    case "serverchan":
      // Server酱：POST { title, desp }
      await postJson(url, { title, desp: content });
      break;
    case "feishu":
      // 飞书自定义机器人：POST { msg_type: 'text', content: { text } }
      await postJson(url, {
        msg_type: "text",
        content: { text: `${title}\n${content}` },
      });
      break;
    case "dingtalk":
      // 钉钉自定义机器人：POST { msgtype: 'text', text: { content } }
      await postJson(url, {
        msgtype: "text",
        text: { content: `${title}\n${content}` },
      });
      break;
    case "bark":
      // Bark：POST 到 {url}/{title}/{content} 或 POST JSON
      await postJson(url, { title, body: content });
      break;
  }
}
