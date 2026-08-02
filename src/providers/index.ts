import type { Provider } from "./types";
import { deepseekProvider } from "./deepseek";
import { moonshotProvider } from "./moonshot";
import { siliconflowProvider } from "./siliconflow";
import { openrouterProvider } from "./openrouter";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { alibabaBailianProvider } from "./alibaba";
import { volcanoArkProvider } from "./volcano";
import { baiduQianfanProvider } from "./baidu";
import { zhipuProvider } from "./zhipu";

/**
 * 已注册的 Provider 列表（新增平台在这里登记）
 * 自动查询优先展示：DeepSeek / Kimi / SiliconFlow / OpenRouter
 */
export const providers: Provider[] = [
  // —— 官方余额接口（自动查询）——
  deepseekProvider,
  moonshotProvider,
  siliconflowProvider,
  openrouterProvider,
  // —— 手动登记模式 ——
  zhipuProvider,
  openaiProvider,
  anthropicProvider,
  geminiProvider,
  alibabaBailianProvider,
  volcanoArkProvider,
  baiduQianfanProvider,
];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
