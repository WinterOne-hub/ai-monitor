import { invoke } from "@tauri-apps/api/core";
import { upsertPrice, getSetting, setSetting } from "./db";

/**
 * 动态同步平台模型价格（硅基流动等聚合平台）
 * 通过抓取官网页面解析全部模型价格，写入 price_table。
 * 模型上架/下架/价格变化都能跟随。
 */

const SILICONFLOW_PRICE_URL = "https://siliconflow.cn/models";

function decodeChunk(s: string): string {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s;
  }
}

/** 同步硅基流动全部模型价格，返回同步数量 */
export async function syncSiliconflowPrices(): Promise<number> {
  const html = await invoke<string>("http_get_text", { url: SILICONFLOW_PRICE_URL });

  // 提取 Next.js RSC chunks 并解码合并
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:\\.|[^"])*)"\]\)/g)].map((m) => m[1]);
  const full = chunks.map(decodeChunk).join("");

  // 解析模型价格对象（modelName -> inputPrice -> outputPrice，desc 可能很长）
  const modelRe =
    /"modelName":"([^"]+)".*?"inputPrice":(\d+(?:\.\d+)?).*?"outputPrice":(\d+(?:\.\d+)?)/gs;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = modelRe.exec(full)) !== null) {
    await upsertPrice({
      providerId: "siliconflow",
      model: match[1],
      inputPrice: parseFloat(match[2]),
      outputPrice: parseFloat(match[3]),
      cacheHitPrice: 0,
    });
    count++;
  }
  return count;
}

/** 检查并同步（节流：默认每 24 小时一次），返回本次是否同步及数量 */
export async function syncPricesIfNeeded(force = false): Promise<{ synced: boolean; count: number }> {
  try {
    const lastRaw = await getSetting("last_price_sync");
    const lastTs = lastRaw ? new Date(lastRaw).getTime() : 0;
    if (!force && Date.now() - lastTs < 24 * 60 * 60 * 1000) {
      return { synced: false, count: 0 };
    }
    const count = await syncSiliconflowPrices();
    await setSetting("last_price_sync", new Date().toISOString());
    return { synced: true, count };
  } catch (e) {
    console.error("模型价格同步失败", e);
    return { synced: false, count: 0 };
  }
}
