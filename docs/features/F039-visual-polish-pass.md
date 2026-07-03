---
id: F039
title: 前端视觉打磨 pass（三参考规范对标）
status: done
owner: 黄仁勋
created: 2026-07-03
completed: 2026-07-03
---

# F039 — 前端视觉打磨 pass（三参考规范对标）

> 小孙 /goal 原话："我们的前端还是不够好看，有没有还可以优化的地方？必须参考：
> github.com/google-labs-code/design.md、github.com/Leonxlnx/taste-skill、
> github.com/nextlevelbuilder/ui-ux-pro-max-skill。你觉得好可以直接做一版，我明天早上来验收"。
> 模式 = **Redesign-Preserve**（taste-skill §11）：演化 F036 的 clowder OKLCH 暖色语言，不推翻、不动 IA/布局。

## Why

F036 restyle 立住了暖色底座（OKLCH 4 档表面 + 暖金 accent + 4 档圆角），小孙验收"还可以"（不惊艳）。
对照三参考规范审计（2026-07-03 实测 grep）发现的剩余视觉债，全部是**底座之上的一致性/精致度层**：

1. **642 处裸 Tailwind 冷色**：semantic 5 色 token 在 globals.css 定义了但没接进 tailwind.config，
   状态/身份色全用股票默认色（red/green/emerald/blue/amber/violet/teal…16 个 hue 家族混用，
   green 与 emerald 双色并存表达同一"成功"语义），冷调与暖 OKLCH 底座打架 —— 正是 F036 要消灭的
   "股票 Tailwind 脸"在状态色层的残留。（taste-skill §4.2 Color Consistency Lock / pro-max §6 color-semantic）
2. **298 处任意字号**：无字阶 token，text-[10px]×162 / text-[11px]×62 散落，还有 8px/9px 共 26 处
   低于可读下限。（pro-max §6 font-scale：body <12px 反模式 / design.md spec：typography levels）
3. **focus-visible 全站为 0**，40 个含按钮文件 + 22 处裸 outline-none 杀焦点环 —— 键盘可达性缺失。
   （pro-max §1 CRITICAL focus-states）
4. **14 个文件用 emoji 当结构图标**（⚙️📋✅❌ 等 chrome 用途），lucide-react 已装但没统一。
   （taste-skill §3.D / pro-max "No Emoji as Structural Icons"）
5. **Loading 全是纯文字"加载中…"**（skeleton 仅 3 处）、空房间空态是一行斜体"尚无消息。"。
   （taste-skill §4.5 状态全周期 / pro-max progressive-loading + empty-states）
6. **动效无系统**：transition 时长散落、无按压反馈、breathe/approval-pulse 无 prefers-reduced-motion 降级。
   （taste-skill §6.B mandatory / pro-max §7 motion-consistency）
7. **无设计真相源文档**：token 语义只活在 globals.css 注释里，跨 session/跨 agent 无法对齐。
   （google-labs-code/design.md：DESIGN.md 作为人机共读的设计合同）

## What

七件套，全部 token/组件级演化，零 IA/布局改动：

- **DESIGN.md 设计真相源**（repo 根）：按 design.md spec 写 YAML tokens frontmatter +
  Overview/Colors/Typography/Layout/Elevation/Shapes/Components/Do's-Don'ts 八章，实值与代码一致。
- **状态色/身份色暖调和**：tailwind.config 重映射 16 个 hue 家族为 OKLCH 派生调和阶
  （同 L/C ramp、hue 区分，hex 落值保 opacity 修饰符——F036 slate 同款打法），
  类名零改动 → 642 处一次生效、测试不破；emerald 并入 green（单一成功语义）；
  theme.ts PROVIDER_ACCENT 三个硬编码 hex 同步调和值。
- **字阶 token + 全库 snap**：fontSize 语义阶（按现状聚类），text-[Npx] 任意值全量 snap，
  8/9px 升 10px 底线。
- **focus-visible 焦点环系统**：全局 :focus-visible accent ring + 22 处 outline-none 清理。
- **图标纪律**：14 文件结构 emoji → lucide 统一图标（agent 身份 emoji 头像/消息内容 emoji 不动）。
- **状态反馈**：关键异步列表补 skeleton（timeline 首载/KB 列表）、按钮按压反馈、
  transition 时长收敛、reduced-motion 降级。
- **空房间欢迎空态**（roadmap P0#6 backlog 复活，视觉版）：三 agent 介绍 + @ 用法提示。

## Acceptance Criteria

- [x] AC0: repo 根 `DESIGN.md` 落库，符合 design.md spec 结构（YAML frontmatter tokens + 八章 prose），
      token 值与 globals.css / tailwind.config 实值一致（guardian 抽查 accent/surface 4 档/radius 4 档/字阶 3 档
      + neutral/semantic/identity 全对上）。
- [x] AC1: tailwind.config 状态色重映射后，全站无股票默认冷色残留（guardian 活体抽查 KB/警告/审批面板）；
      `emerald-*` 与 `green-*` 同一 const 对象引用；PROVIDER_ACCENT 同步调和 hex；前端 vitest 零破坏。
- [x] AC2: fontSize 语义字阶 micro/caption/compact 落 tailwind.config；`text-[Npx]`（N≤16）任意值清零
      （299→0，8/9px 升 10px 底线；22-64px display 级豁免已在 DESIGN.md 登记）。
- [x] AC3: 全局 :focus-visible 2px accent 环生效（guardian Tab 实测 computed style = accent-400）；
      全库 23 处 `outline-none` 均有 focus:/focus-visible: 替代（2 处为邻元素 affordance：
      composer 外壳 focus-within / resize grip group-focus-visible，guardian 逐处亲证）。
- [x] AC4: runtime-log 系 14 文件 60+ 结构 emoji → lucide（残留仅注释豁免区）+ guardian 点名的
      全站 5 处散装 emoji 扫尾（Mail/Lock/Globe/Timer/AlertTriangle）；身份/内容 emoji 保留。
- [x] AC5: KB 派生视图列表 + a2a 调用树 loading 换 SkeletonLines 骨架；主 CTA 按压反馈；
      reduced-motion 降级。**修订**：原文「timeline 首载 skeleton」改判 N/A——thread-store 无
      loading 语义，加旗标属行为改动越 Redesign-Preserve scope，空态行为与改前等价（留后续）。
- [x] AC6: 空房间欢迎空态（AGENT_PROFILES 数据驱动名册卡：角色/擅长/@所有人 提示），TDD 3 用例 +
      guardian 活体截图确认。
- [x] AC7: `pnpm typecheck` 0 + 前端 vitest 818/818 + `pnpm test:api` 0 + `pnpm build` 0
      （rebase 到最新 origin/dev 后全量复跑，吃进 F038 Playwright 基建 + F027 promote 补丁零冲突）；
      preview :3103 / API :8803 活体待小孙验收。

## Dependencies

- 无硬依赖。建立在 F036（OKLCH token 底座）之上。
- 与 F033（worktree 未合，interactive cards）并行：F039 走 config 级重映射，类名不动，冲突面最小。

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| Design Gate | 先出 mock 等小孙拍 vs 直接做进真 App | **直接做，明早活体验收** | 小孙 /goal 原话授权"你觉得好可以直接做一版"；F036 先例=静态 mock 判不了，做进真 App 才立得住 |
| 重设计模式 | Preserve vs Overhaul | **Preserve** | F036 方向小孙已拍（"这个不错"），本轮只做一致性/精致度层 |
| 状态色落地方式 | 逐处改 642 个类名 vs config 重映射 hue 家族 | **config 重映射（hex 落值）** | F036 slate 同款打法：类名零改动、测试不破、opacity 修饰符保留（var(oklch)+opacity 会静默失效——F036 已踩） |
| 字体 | 换字体 vs 保持 Inter+Noto Sans SC | **不换** | taste-skill 对 Inter 的 override 条款：中性产品 UI + 项目已有即合理；夜间换字体回归风险不成比例 |
| 暗色模式 | 本轮做 vs 不做 | **不做** | roadmap P2 backlog 未选项，scope 纪律 |
| 右栏密度重构 | 做 vs 不做 | **不做** | 触 IA，Redesign-Preserve 红线（taste-skill §11.F） |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-03 | Kickoff（小孙 /goal 夜间授权）；三参考库审计 + 前端 grep 量化审计完成 |
| 2026-07-03 夜 | 实现完成（4 commit：底座层/图标+骨架/lint 收尾/emoji 扫尾）；quality-gate 全绿；零上下文 guardian **PASS**（AC0-AC7 全过 0 FAIL，报告+6 截图在 worktree `.agents/acceptance/F039/`）；范德彪 codex r1 **GO**（0 P1/P2/P3）；按其 residual risk 提示 rebase 最新 origin/dev（吃 F038/F027 补丁零冲突）+ 全量复门禁绿（typecheck 0 / vitest 818 / api 0 / build 0）；分支已推 origin |
| 2026-07-03 | 小孙 :3103 活体验收通过（「非常」）；squash `5ec9c1d` 合 dev + push；worktree 清理；**DONE**。后续：本次方法论沉淀为 skill（小孙点名） |

## Links

- 参考：github.com/google-labs-code/design.md（DESIGN.md spec）/ github.com/Leonxlnx/taste-skill（anti-slop + redesign 协议）/ github.com/nextlevelbuilder/ui-ux-pro-max-skill（产品 UI 99 条 UX 规则）
- Related: F036（底座）、F033（并行 worktree）、frontend-improvement-roadmap 记忆（P0#6 空态复活）

## Evolution

- **Evolved from**: F036
- **Blocks**: 无
- **Related**: F033
