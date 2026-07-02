---
id: F033
title: 交互卡片：select/confirm 选择块（C2）
status: in-progress
owner: 黄仁勋
created: 2026-06-13
started: 2026-07-02
---

# F033 — 交互卡片：select/confirm 选择块（C2）

> clowder-ai 借鉴批次第 4 个，原 Blocked by F030（已 done 2026-06-14 解锁）。小孙 2026-07-02 拍板独立开工（不并 F020）。
> 参考：clowder-ai `docs/features/F096-interactive-rich-blocks.md`（含 Post-ship Lessons：单选也要确认步骤、confirm 消息必须带上下文、IME isComposing 守卫）。

## Why

agent 要小孙做选择目前只能纯文字问答，决策散在 thread 里事后难找。交互卡片让"选方案/确认操作"变成持久化的可点击块，选完留痕。

## What（Design Gate 定案 2026-07-02）

**F033 = `request_decision` 轨的升级（渲染 + 生命周期 + 持久化），不是 cc_rich 新 kind。**

- 交互的本质是"agent 阻塞等用户回话"，需要活的服务端句柄。`request_decision` 已有完整双向轨：MCP 工具 → DecisionManager blocking promise（decision-manager.ts:69）→ WS `decision.request` → 前端卡片 → WS `decision.respond` → promise resolve。cc_rich 是持久化死文本，没有等待方——F030 doc Design Decision 自己已写明此理由把交互推给 F033。
- 复用 F030 的是**视觉语言**（card tone/fields、F036 OKLCH token），不是 fence 协议。cc_rich 保持只读，preview 泄漏面（6 处摘要面共用 stripRichFencesForPreview）、fail-closed 降级、消息 overwrite FTS 重索引三族雷全部避开。
- MCP 工具面扩展 `kind: "select" | "multi_select" | "confirm"`，映射到现有内部 kind（select→multi_choice+单选、multi_select→multi_choice+多选、confirm→inline_confirmation），WS payload 类型零破坏。
- 新增 `decision_records` 持久化表：pending 时落行，respond/timeout 时更新；resolved 卡片在时间线保留 disabled 渲染（刷新/重启不丢）。
- groupId 表单**已砍**（YAGNI，德彪 OQ3）。

## Acceptance Criteria（2026-07-02 细化）

- [x] AC1: select / multi_select / confirm 三 kind 经 MCP `request_decision` 可达，前端按 kind 分渲染（select=单选+**显式提交**，multi_select=复选+提交，confirm=上下文正文+确认/取消），选择经 WS `decision.respond` 结构化回传 resolve MCP promise（guardian 全链路逐环核对 + 小孙点击流验收 2026-07-03）
- [x] AC2: 响应后卡片转 disabled 态（高亮所选、不可再点），选择结果持久化到 `decision_records`，浏览器刷新与服务器重启后 resolved 卡片仍按 anchor 渲染；重启时残留 pending 行标 orphaned（前端显示"已过期"）（服务器侧活体：种 pending→重启→orphanedDecisions:1→端点回读；刷新流小孙验收）
- [x] AC3: 回传到源 thread 的审计消息自带上下文（title + description + 所选 label），timeout 分支同样写留痕并标注"超时自动处理"（decision-manager 测试钉死：timeout 留痕 + 上下文断言）
- [x] AC4: 决策卡内任何 Enter 提交路径带 `isComposing` 守卫 + 组件测试；同族缺陷顺手修：composer.tsx 主输入框补同一守卫（原全库 0 处 IME 守卫，RED 实锤组合态 Enter 误发送后修复 + 双向测试）

## Dependencies

- **Blocked by**: F030（协议基础）— 已 done 2026-06-14，解锁

## Design Decisions

| 决策 | 结论 | 原因 |
|------|------|------|
| 响应通道 | **禁照抄 clowder "选择=发普通文字"**，必须保留结构化 decision.respond | 我们 request_decision 阻塞等结构化响应（message-service.ts:3236），纯文字会挂死 MCP promise；普通消息只做审计副本 |
| 轨道选择（Design Gate） | decision card 升级，**不加 cc_rich interactive kind** | 交互需要活的服务端等待句柄，文本轨没有；且避开 preview 泄漏/fail-closed 降级/FTS 重索引三族雷 |
| kind 映射 | MCP 面暴露 select/multi_select/confirm，内部复用既有三 kind | DecisionRequest["kind"] 与 WS 事件零类型破坏；fan_in_selector（F002/A2A fan-in）不动 |
| timeout 语义 | **confirm 超时 = rejected（fail-closed）**；select/multi_select 保持现状全批不变，但留痕标注"超时自动通过" | "确认操作"绝不能超时自动通过；既有 multi_choice 消费者行为零回归 |
| 单选提交 | 单选也要显式提交按钮，点 radio 不直接回传 | clowder F096 Post-ship Lesson B1 |
| 持久化 | 新表 decision_records（不复用 room_decisions） | room_decisions 是 F027 取景器防漂 ledger，语义不同；决策卡生命周期独立 |
| groupId 表单 | 砍 | YAGNI（德彪 OQ3） |
| 与 F020 关系 | 独立开工（小孙 2026-07-02 拍） | F020 挂载矩阵挂的就是 decision card，两者正交可组合 |

## 进度（2026-07-03）

| 关卡 | 结果 |
|------|------|
| quality-gate | 本轮全量：typecheck 0 错 / test:api 3475 pass / components 749 pass / lint·build exit 0 |
| AC2 服务器侧活体 | preview 种 pending → 重启 → boot log `orphanedDecisions:1` → records 端点回读 orphaned ✅ |
| acceptance-guardian | **PASS**（api 26/26 + 组件 49/49 真跑；FanInCard 与 dev byte-identical；O3 class 冲突已修 `70d8419`） |
| 范德彪 r1 | NEEDS-WORK：P1 respond 无运行时校验 + P1 副作用阻断终态广播/timer 异常逃逸 + P3 store 跨房累积 |
| 修复 | `6265662`：validateDecisions fail-closed + persistAndAudit 隔离 + timeout 整体兜底 + fetchRecords 本房过滤（12 新测试 Red→Green） |
| 范德彪 r2 | **GO**（三项全 RESOLVED，无新阻断） |
| 小孙活体验收 | 通过，拍板合入（2026-07-03） |

Commit 链：`47e9d62`(docs) → `6460cb6` → `fc40245` → `edc0386` → `c82b613` → `1208f04` → `81d5954` → `f8df58f` → `9293ae9` → `b458662` → `70d8419` → `6265662`。

## Evolution

- **Evolved from**: F030
- **Related**: F020、F002（Decision Board）
