## AI Monitor v0.1.4

### ✨ New Features / 新增功能
- 📊 **Usage analytics** — monthly bill, per-model cost ranking, CSV export
  - 用量分析：月度账单、模型费用排行、CSV 导出
- ⌨️ **Global shortcuts** — Cmd+Shift+Space toggle overlay, Cmd+Shift+O open dashboard
  - 全局快捷键：Cmd+Shift+Space 呼出/隐藏悬浮卡，Cmd+Shift+O 打开面板
- 🖥️ **Tray states** — dynamic tray title shows live balance / today's spend
  - 托盘状态：托盘标题实时显示余额与今日花费
- 🧾 **Cost reconciliation** — proxy-recorded cost vs balance-diff, latest balance via GROUP BY MAX(id)
  - 费用校准：代理记账与余额差值对账，余额按最新快照展示
- 🔒 **x-proxy-secret** — optional secret header for proxy access control
  - 代理密钥：可选 x-proxy-secret 请求头保护本地代理
- 📦 **Auto-updater** — tauri-plugin-updater integration
  - 自动更新：接入 tauri 更新插件
- 🖥️ **Multi-monitor position persistence**
  - 多显示器位置记忆
- 📈 **Monthly bill + model ranking + CSV export** in Usage tab
  - 用量页新增月度账单、模型排行、CSV 导出
- 🚨 **Low-balance pulse** — overlay pulses when balance hits threshold
  - 低余额闪烁提醒：余额低于阈值时悬浮卡闪烁
- 🎨 **CSS design tokens** — consistent theming across overlay & dashboard
  - 设计令牌：统一悬浮卡与面板主题
- ✨ **Collection error banner** — visible banner when balance collection fails
  - 采集失败提示条：余额采集异常时面板显示提示

### 🐛 Bug Fixes / 修复
- ECharts tree-shaking; overlay reuses dashboardStore (single source of truth)
  - 修复：ECharts 按需引入；悬浮卡与面板共用数据源
- Esc collapses overlay; overlay/dashboard mutual exclusion enforced
  - 修复：Esc 收起悬浮卡；悬浮卡与面板互斥
- Swap global shortcuts off Alt (macOS IME conflict)
  - 修复：全局快捷键避开 Alt 键（macOS 输入法冲突）
- Preserve proxy-recorded daily cost vs balance-diff
  - 修复：代理记账与余额差值数据互不覆盖
- Global auto-collect guard (shared last_collect_at)
  - 修复：全局自动采集防抖（共享 last_collect_at）
- Revert vibrancy; island/dashboard coexistence fixed
  - 修复：回退毛玻璃效果，悬浮岛与面板共存问题

### 🧹 Chores / 其他
- Lint / typecheck / format toolchain (ESLint + Prettier + vue-tsc)
  - 新增代码规范工具链
- Promo & docs: xiaohongshu cards, integration checklist
  - 新增小红书推广素材与接入清单文档

Made with [Proma](https://proma.cool) · [GitHub](https://github.com/proma-ai/Proma)
