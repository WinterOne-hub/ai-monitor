## AI Monitor v0.1.5

### 🐛 Bug Fixes / 修复

- ⏱️ **Auto-collect interval now actually applies** — recursive setTimeout reads `collect_interval_minutes` every cycle; setting 1-minute interval previously only ran every 30 min
  - 修复：自动采集间隔真正生效（此前无论设置多少分钟，实际固定 30 分钟才采集一次）
- 💸 **Negative daily cost fixed** — Anthropic-compatible endpoints (e.g. DeepSeek) return session-cumulative `cache_creation_input_tokens`; now only `cache_read_input_tokens` counts, with `min(input)` guard
  - 修复：今日消费出现负数（cache_creation 被当作本次增量，累计 1900 万导致费用 -34 元）
- 💰 **Daily cost no longer stuck at 0** — proxy record writes estimated cost into `cost` column (was hardcoded 0, and balance-diff sync skipped proxy days)
  - 修复：今日消费一直不变（代理记账 cost 固定写 0，余额差值同步被跳过）
- 🧹 **Historical cost backfill runs once** — migration marked in settings; no longer re-runs with hardcoded DeepSeek prices on every startup
  - 修复：历史费用回填只在首次执行，不再每次启动覆盖
- 🚨 **Low-balance alert detects further drops** — during cooldown, if balance drops another 50%, alert again
  - 增强：余额告警冷却期内若继续大幅下跌，会再次提醒
- 🛡️ **Record-miss logging** — proxy prints a clear warning when an API key matches no account and no default is set (was silent data loss)
  - 增强：记账账户未匹配时打印明确日志，不再静默丢失统计
- 🔄 **Stream usage for more platforms** — `stream_options.include_usage` injected for all OpenAI-compatible providers (OpenRouter / SiliconFlow / Moonshot / DeepSeek), not just OpenAI
  - 增强：流式 token 统计覆盖更多 OpenAI 兼容平台
- ⚡ **Auto-collect race fixed** — guard against duplicate timers when changing interval while a schedule is pending
  - 修复：修改采集间隔与调度中可能产生双定时器的竞态

Made with [Proma](https://proma.cool) · [GitHub](https://github.com/proma-ai/Proma)

### 💰 Balance & spend now stay in sync / 余额与消费同步
- Cost uses real balance diff (authoritative), not token estimate; partial-drop sum resets on top-up
  - 修复：今日消费改为以余额差值（真实扣费）为准，不再被 token 估算卡住；逐段下降求和，中途充值不抹掉历史消耗
