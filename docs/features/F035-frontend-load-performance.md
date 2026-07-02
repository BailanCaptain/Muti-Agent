---
id: F035
title: 前端加载性能：bundle 基线 + 代码分割（D1）
status: in-progress
owner: 黄仁勋
created: 2026-06-13
---

# F035 — 前端加载性能：bundle 基线 + 代码分割（D1）

> clowder-ai 借鉴批次第 6 个（队尾）。2026-07-03 基线实测完成，走 AC4 合法提前 close 出口（数据不支持分割）。德彪 r1 GO（零 P1 + 5 P2 全修 `67b81f0`）→ r2 CONFIRMED-GO（5/5 逐条复核 ✅）。

## Why

chat 组件全部静态导入在入口（page.tsx 直接静态导入七个顶层组件——实测比 spec 原记的六个多一个），零 `next/dynamic`。但"该不该分割、分割多少"目前没有数据——德彪 OQ1：先有 bundle 基线和预算才动手，不赌。

## What

**基线先行**：AC1 就是跑 bundle analyzer 出基线 + 定预算。数据说该分割 → 对非首屏面板（StatusPanel/DebugPanel/preview 等）做 `next/dynamic`；数据说没问题 → 提前 close，不为做而做。

## Acceptance Criteria

- [x] AC1: bundle 基线报告（首屏 JS 体积 / 各 chunk 构成）+ 预算定义 —— 见下方基线报告；预算 = first-load JS gzip ≤ 400 KiB，固化在 `scripts/measure-first-load.mjs`（超标非零退出）
- [ ] ~~AC2: 若超预算——非首屏组件按需加载~~（N/A：基线在预算内，未触发）
- [ ] ~~AC3: 加载性能前后对照~~（N/A：同上，无"后"可对照）
- [x] AC4: 基线达标——记录结论提前 close（合法出口）—— 判定与依据见下方分叉判定节

## 基线报告（AC1 · 2026-07-03 实测）

环境：worktree F035 @ dev `c7ad1f2` + D0 `43804db` · Next 16.0.10 Turbopack production build

**首页 `/` first-load JS：1077.2 KiB raw / 313.8 KiB gzip（10 chunks）+ CSS 67.9 KiB raw / 12.6 KiB gzip**（全文尺寸均为 KiB=1024 bytes，德彪 r1 P2 口径统一）
first-load 占全部 JS（14 chunks / 1161.9 KiB）的 **92.7%**——除 /debug/a2a 专属 chunk 外全量首屏下发。

| chunk | raw KiB | gzip KiB | 构成（特征串归因实测） |
|---|---|---|---|
| e3610a1d | 453.7 | 127.8 | vendor+业务混合：lucide-react + micromark/react-markdown 链 + zustand + 业务代码（sessionGroup/wake.trigger 特征串命中） |
| 859af4a2 | 293.3 | 87.2 | react-dom |
| a6dad97d | 110.0 | 38.7 | polyfill + scheduler |
| adeec2a9 | 85.3 | 21.5 | Next.js app-router 客户端运行时 |
| 746a91f6 | 75.7 | 19.9 | 业务代码（sessionGroup/cc_rich 命中） |
| 其余 5 个 | 59.2 | 18.7 | 杂项小 chunk |

**测量方法**（可复跑）：`pnpm build` 后 `node scripts/measure-first-load.mjs [route]`。
原理：扫描 `.next/server/app/index.html` 静态预渲染产物中全部 `/_next/static/chunks/*.js` 引用（含 `<script>`、preload、RSC payload 引用）→ 逐 chunk 算 raw+gzip。这是「HTML 声明/引用的首屏 JS」**保守口径**（上界≈浏览器真实加载，德彪 r1 P2 措辞校正）；抓到 0 chunk 时显式 exit 1 防假绿。
为什么不用 analyzer：Next 16 Turbopack build 已不打印 per-route First Load JS（上游已知回退）；内建 Turbopack bundle analyzer（`--analyze`）需 **16.1+**，本仓 16.0.10 不可用；`@next/bundle-analyzer` 是 webpack 插件路线。本方案零新依赖，顺带避开"合 dep 后主仓忘 pnpm install"地雷（LL-017）。

## 预算定义（AC1 交付）

**first-load JS gzip ≤ 400 KiB**，写死在 `scripts/measure-first-load.mjs`，超标非零退出（可挂 CI / 手动巡检）。

锚点推理：
- 框架不可动底座 = react-dom 87.2 + polyfill/scheduler 38.7 + app-router runtime 21.5 ≈ **147 KiB gz（占当前总量 47%）**——任何代码分割都碰不到这部分
- 本应用是 localhost 单用户内部工具：loopback 传输时间 ≈ 0，成本只剩 parse/eval（约 1MB JS 桌面机一次性 100-300ms，SPA 常驻全天摊销）
- 400 = 当前 314 + ~86 KiB 余量：预算的功能是**防蠕变告警**（未来引入图表/编辑器类重 vendor 时自动报警），不是给分割立军令状

## AC2/AC3 vs AC4 分叉判定 → AC4 提前 close

数据不支持分割：

1. 真正可延迟的候选（SettingsModal / BrowserPanel 等按需面板）落在非框架的 ~167 KiB gz 里，激进分割估算省 20-60 KiB gz（总量 7-19%）——loopback 场景收益体感为零
2. react-markdown 链（最大 chunk 的主要成分之一）按产品形态首屏渲染消息就要用——依据是静态导入链 `TimelinePanel → message-bubble → markdown-message`（代码链证据）+ 打开即看历史消息的交互假设；预渲染产物本身是空消息态，此条是**产品假设/交互判断而非硬测量结论**（德彪 r1 P2 降级）。分割它 = 消息内容闪烁，负收益
3. 分割的代价真实存在：loading 态闪烁 + 组件边界复杂化 + 测试面扩大
4. spec 预置约束（德彪 OQ1）：数据说没问题 → 提前 close，不为做而做

**重开触发器**（任一命中即重开评估）：
① `measure-first-load` 报超 400 KiB
② 新增重 vendor（charting / editor / PDF 类）
③ 部署形态变化（不再 localhost-only）

## Dependencies

- 无硬依赖。前置小 debt D0（next.config.ts `ignoreBuildErrors: true`）已修：`43804db`，独立 commit 先行合入。build 实证 `Running TypeScript` 真跑且 0 错——存量代码无被掩盖类型错，纯 3 行配置删除。
- 已知 churn（德彪 r1 P2 备案，非 D0 引入）：typedRoutes 下 `next-env.d.ts` 的 routes.d.ts import 会在 `next dev`（`./.next/dev/types/`）与 `next build`（`./.next/types/`）之间来回翻。canonical 取 dev 形态（主仓日常跑 dev）；build 后的翻转视为本地噪音不提交。

## Design Decisions

| 决策 | 结论 | 原因 |
|------|------|------|
| 立项依据 | 数据驱动，基线先行 | "36 组件全静态导入"等断言需 analyzer 证明（德彪 OQ5：subagent 行数数据曾错报，量化断言必实测） |
| D2 组件/store 重构 | **不立项** | 原依据"thread-store 2907 行"实测 695 行，前提为错数据；按真实痛点再议 |
| 测量方案 | 预渲染 HTML 提取 + 零依赖脚本 | Next 16.0.10 Turbopack：route 表无尺寸列、`--analyze` 需 16.1+、webpack analyzer 不适用；HTML 引用清单 = 首屏 JS 保守口径（上界≈真实加载） |
| 预算数 | gzip ≤ 400 KiB | 锚定框架底座 147 KiB × 余量；localhost 工具场景 parse/eval 是唯一真实成本；预算定位是防蠕变不是逼分割 |
| 分叉出口 | AC4 提前 close | 分割上限收益 7-19% gz、体感为零、代价真实；三条重开触发器留门 |

## Evolution

- **Evolved from**: F009（全链路性能优化）
- **Related**: F012
