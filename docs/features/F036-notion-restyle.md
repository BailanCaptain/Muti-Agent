---
id: F036
title: 前端 Notion/clowder 风 restyle + 前端审计 P0/P1/P2 收口
status: done
owner: 黄仁勋
created: 2026-06-13
completed: 2026-07-02
---

# F036 — 前端 Notion/clowder 风 restyle + 前端审计收口

> 视觉参考 = clowder-ai 前端（`C:\Users\-\Desktop\cafe-multi-agent\clowder-ai`）+ claude.ai 暖色美学。
> 起点是 35-agent 前端审计（对照 clowder），小孙拍定 8 项执行清单 + restyle 本体，决定"全在本 feature 做完"。
> 关联记忆：frontend-improvement-roadmap、f036_notion_restyle。

## Why

前端是"股票 Tailwind 冷蓝脸"：冷色 slate、毛玻璃、渐变辉光，与 clowder/claude.ai 的暖中性 + 4 档表面高度差距大。
同时 35-agent 审计扒出一批真缺口（catalog 漏 xhigh、进度条颜色与真实封存阈值矛盾、死链、死代码、散落圆角、
"三个下一轮"同名歧义、rich 卡型偏少、长会话无导航）。本 feature 一次性做完 restyle 本体 + 这批收口。

## What

- **restyle 本体**：移植 clowder OKLCH token（4 档表面 sunken<surface<elevated<canvas、暖中性 slate 重映射、
  暖金 accent ≈ Claude clay、elevation 阴影），全站去冷色/毛玻璃；F030 rich 卡补暖色。
- **审计收口 10 项**（见 AC）。

## Acceptance Criteria

- [x] AC0 restyle 本体：OKLCH token 移植 + 4 档表面高度翻正（聊天区最亮）+ 全站冷色/毛玻璃去除 + F030 rich 卡（card/checklist/diff/image）补暖色。小孙截图验收"restyle 可以的"。（commit `b56bb21`）
- [x] AC1 删死链「会话链 →」：`observation-bar.tsx` / `status-panel.tsx` 的 `#invocation-chain` 无目标锚点。（`fb917e4`）
- [x] AC2 进度条颜色对齐真实封存阈值：`agent-list.tsx` `fillRatioTone` 从写死 0.5/0.7 改为按 provider `actionPct` 算（warn = action − 0.1），消除"Claude 0.72 飘红却显示剩余 18%"的自相矛盾。（`fb917e4`）
- [x] AC3 「Seal 阈值」改名「自动封存阈值（Seal）」+ 人话 helper：讲清达比例本轮末封存、下轮开新 native session、留空回落 provider 默认（claude 90% / codex 85% / gemini 80%）。（`09fc3fa`）
- [x] AC4 圆角统一（全库扫 B 方案）：tailwind.config.ts 定 4 档语义 radius token（field12/card16/panel20/floating24），snap 全库 24 处 `rounded-[Npx]` 任意值。（`6083422`）
- [x] AC5 claude effort 补 xhigh（实测 CLI 2.1.177）+ agent effort 闭集白名单（注入前 `resolveEffectiveOverride` + 全局 `sanitize` 双层，堵 session 直调洞）。（`a79f459`）
- [x] AC6 删死代码：`hero-header.tsx` + `provider-strip.tsx`（主屏零 import 孤儿）。（`032f9a0`）
- [x] AC7 cli-output 定论 = 删孤儿 `CliOutputBlock` + `toCliEvents`（**非"接回"**，见 Design Decisions）。（`9f85b04`）
- [x] AC8 「三个下一轮」语义梳理：调研出排队/封存/挂起三义，给唯一真歧义（config 裸"生效"）补"配置"限定 + 对比注。（`6b9a0fc`）
- [x] AC9 长会话导航 = 形态 D 滚动条标记/迷你地图：右边缘竖轨投影 🔵你的提问 / 🔴封存（**仅持久锚点**），hover 摘要、click scrollToIndex 跳。**决策不打标**（范德彪-r P1：decision-store 是 pending-only，已答决策离开 timeline，打标会"响应后消失"；已答决策经其 user 响应消息可达）。（`f271342` + 范德彪-r 修）
- [x] AC10 rich 卡型扩展：新增只读 table + progress 两种 cc_rich 卡（覆盖对比 / 投票计票；真投票交互归 F033）。table 行宽 == 列数 fail-closed（范德彪-r P2：超宽行多余格会被渲染静默丢弃 → union superRefine 拒收）。（`9564079` + 范德彪-r 修）
- [x] AC11 restyle 测试债修复：拖拽边框 violet→accent、连接气泡 indigo→surface-canvas 的 test + 注释同步。（`0aef78d`）

## Dependencies

- 无硬依赖。建立在 F021（右栏）/ F022（左栏）/ F030（rich blocks）/ F012（Block 体系）之上。
- table/progress 的真投票/交互态归 **F033 交互卡片**（本期只读）。

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| #4 圆角范围 | 浅扫(只动认可视觉面) vs 全库扫 | **全库扫(B)** | 小孙拍 B，彻底统一，消灭散落任意值 |
| #4 顶层 token 命名 | `xl` vs 非内置名 | **`floating`(24px)** | `xl` 会撞 Tailwind 内置 `rounded-xl`(12px)，override 静默改写全站含头像 squircle |
| #4 头像圆角 | 一并 snap vs 例外 | **例外保留** | `provider-avatar` 的 10/22/32px 是随尺寸渐变的 squircle 阶梯（另一套视觉语言），硬掰会把 96px 头像变卡片角 |
| #7 cli-output | 接回活路径 vs 删除 | **删除孤儿** | roadmap 列其在「别追」且不在 8 项执行清单；B013(2026-04-14)曾学 clowder 统一进深色块，但 **F012 三人一致共识推翻**（AC-06 拆分渲染路径 / AC-08 CliOutputBlock 只裹工具不裹文字，均 done）；当前 message-bubble 早改用浅色 ToolEventsSummary，CliOutputBlock 沦为零 import 孤儿。"接回"= 重新引入被否决的深色黑匣子 + 撞浅色主题 |
| #8 下一轮措辞 | 三词拆开 vs 同锚点 + 概念前缀 | **同锚点「下一轮」+ 概念词区分** | 封存/挂起本是同一 invocation 边界（不强行拆词制造"时机不同"错觉）；排队已用"当前回复结束后"自带区分；只给 config 裸"生效"补"配置"限定 |
| #9 标记定位 | 像素 offset vs 序位 | **序位 index/(count-1)** | 时间线虚拟化，off-screen 项估算高度，像素投影会随滚动漂移；序位稳定、保序、零内部 API 依赖 |
| #9 标记轨容器 | scroll 内 vs relative wrapper | **包一层 relative wrapper** | 标记轨需视口固定不随内容滚；pointer-events-none 轨道 + auto 标记，不挡聊天点击 |
| #9 决策是否打标 | 打标 vs 不打标（范德彪-r P1） | **不打标，只标提问/封存** | decision-store 是 pending-only（响应即删、刷新只拉 pending），已答决策不在 timeline，打标会"响应后消失"——只标持久锚点；已答决策的导航经其 user 响应消息达成。decision 持久化属 F033 范畴 |
| #10 table 行宽约束 | 成员 .refine vs union superRefine vs 渲染层 defensive | **union superRefine fail-closed**（范德彪-r P2） | 成员 .refine 让该成员变 ZodEffects、进不了 discriminatedUnion（checklist 的 refine 挂内层 items 数组才不破）；渲染层 defensive 会**静默丢弃超宽行多余格**（错误对比/计票）；放最终 union 的 superRefine 既能跨字段校验、成员又仍是 ZodObject，行宽≠列数整段降级纯文本 |
| effort 校验 | 400 拒 vs 静默 drop | **静默 drop**（沿用 runtime-config.ts 历史行为） | model/effort 一致静默 drop，改 400 是 scope 外 |

## 关键技术陷阱（实现期踩到，记录防复发）

- **Tailwind v3.4 opacity 修饰符对 `var(oklch)` 颜色静默失效**：accent/surface 是 `var(--*)`(oklch)，`accent-500/60` 这类 opacity 被静默忽略（渲染全不透明）。需要 opacity 的地方用 hex slate（如 table zebra `even:bg-slate-50`）；accent/surface 只用实色。
- **`xl` 圆角 token 撞内置**：见 Design Decisions。
- **discriminatedUnion 不收 ZodEffects**：`.refine` 挂外层对象 → 整 schema 变 ZodEffects → 编译失败；挂内层字段则外层仍 ZodObject（checklist 范式）。
- **shared 解析路径**：tsconfig paths + vitest alias 均把 `@multi-agent/shared` 指向 `packages/shared/src`，改 schema 前端 typecheck/vitest 无需 rebuild dist（dist 已 gitignore，构建/启动时重生）。

## 实现 / Commit 链

restyle 本体与收口分散在以下 commit（base = dev `09fc3fa` 之后续推）：

```
b56bb21 restyle 本体 + 8 自查打磨
a79f459 #5 xhigh + effort 白名单
fb917e4 #1 删死链 + #2 进度条颜色 + codex-r1 P1/P2
09fc3fa #3 sealPct 改名 + helper
032f9a0 #6 删死代码 hero-header + provider-strip
6083422 #4 圆角统一(全库扫) + radius token
9f85b04 #7 cli-output 删孤儿(非接回)
6b9a0fc #8 三个下一轮语义梳理
f271342 #9 长会话导航 D(timeline-minimap)
9564079 #10 rich 卡型扩展(table + progress)
0aef78d fix 同步 restyle 测试债(violet→accent / indigo→surface-canvas)
```

新增组件：`timeline-minimap.tsx`、`rich-blocks/table-block.tsx`、`rich-blocks/progress-block.tsx`。
删除：`hero-header.tsx`、`provider-strip.tsx`、`rich-blocks/cli-output-block.tsx`、`rich-blocks/toCliEvents.ts`。

## 验证

- 前端 `tsc --noEmit` 绿；`packages/shared` `tsc --noEmit` 绿。
- 前端全量 vitest **722 passed (67 files)**（含新增 timeline-minimap 6 + table 2 + progress 3 + schema 11 + block-renderer 端到端 3）。
- flaky 门禁（docs-watcher / worktree-cleanup 真 IO 测试）经独立隔离验证后 `--no-verify` 提交（小孙授权）。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-13 | 起步：小孙嫌前端丑，4 版静态 mock 判不了 → 开 worktree 做进真 App |
| 2026-06-14 | iteration 3 clowder token 移植，小孙拍"这个不错"方向立住；restyle 本体提交 + 范德彪 r1(NEEDS-WORK 2 条已修) |
| 2026-07-02 | 审计收口 11 项全做完；范德彪终审 r1 NEEDS-WORK(P1 决策标记/P2 table 超宽行) → 修 → r2 GO；小孙 :3103 活体验收通过（"还可以"）；squash 合 dev |

## 收口记录

- [x] 范德彪 codex 最终 review：r1 NEEDS-WORK → 修（table superRefine + 导航去决策标记）→ **r2 GO**
- [x] 小孙活体验收：:3103 preview，「我验过了 还可以」（2026-07-02）
- [x] merge-gate：squash 合 dev，本表条目移「已完成」
