import { createI18n } from "vue-i18n";
import zh from "./locales/zh";
import en from "./locales/en";

export type Locale = "zh" | "en";

/** 检测系统语言：中文系统用中文，其他用英文 */
function detectLocale(): Locale {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { zh, en },
});

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
}
