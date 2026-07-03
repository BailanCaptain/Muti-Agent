---
id: F039
title: 前端视觉打磨 pass（三参考规范对标）
status: spec
owner: 黄仁勋
created: 2026-07-03
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

- [ ] AC0: repo 根 `DESIGN.md` 落库，符合 design.md spec 结构（YAML frontmatter tokens + 八章 prose），
      token 值与 globals.css / tailwind.config 实值一致（抽查 accent-500/surface/radius/字阶）。
- [ ] AC1: tailwind.config 状态色重映射后，全站无股票默认冷色残留（视觉抽查 KB tab/警告/审批面板）；
      `emerald-*` 与 `green-*` 渲染一致；PROVIDER_ACCENT 同步；现有 vitest 类名断言零破坏。
- [ ] AC2: fontSize 语义字阶 token 落 tailwind.config；组件目录 `text-[Npx]`（N≤16）任意值清零；
      8px/9px 全部 ≥10px。
- [ ] AC3: 全局 focus-visible ring 生效（Tab 遍历主界面可见焦点）；裸 `outline-none` 清零
      （替换为 focus-visible 方案）。
- [ ] AC4: 14 个文件的结构 emoji 图标替换为 lucide（统一 size/stroke）；身份/内容 emoji 保留。
- [ ] AC5: timeline 首载 + KB 列表 loading 有 skeleton；主按钮有按压反馈；
      breathe/approval-pulse 在 prefers-reduced-motion 下静止。
- [ ] AC6: 空房间显示欢迎空态（三 agent 介绍 + @ 提示），非一行"尚无消息。"。
- [ ] AC7: `tsc --noEmit` 绿 + 前端 vitest 全绿 + `next build` 过；worktree preview 起给小孙验收。

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

## Links

- 参考：github.com/google-labs-code/design.md（DESIGN.md spec）/ github.com/Leonxlnx/taste-skill（anti-slop + redesign 协议）/ github.com/nextlevelbuilder/ui-ux-pro-max-skill（产品 UI 99 条 UX 规则）
- Related: F036（底座）、F033（并行 worktree）、frontend-improvement-roadmap 记忆（P0#6 空态复活）

## Evolution

- **Evolved from**: F036
- **Blocks**: 无
- **Related**: F033
