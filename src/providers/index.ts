import type { Provider } from "./types";
import { deepseekProvider } from "./deepseek";
import { moonshotProvider } from "./moonshot";
import { siliconflowProvider } from "./siliconflow";
import { zhipuProvider } from "./zhipu";

/** 已注册的 Provider 列表（新增平台在这里登记） */
export const providers: Provider[] = [
  deepseekProvider,
  moonshotProvider,
  siliconflowProvider,
  zhipuProvider,
];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
