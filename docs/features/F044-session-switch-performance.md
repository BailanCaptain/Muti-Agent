---
id: F044
title: 会话切换即时反馈 + 长会话按需加载
status: in-progress
owner: 范德彪
created: 2026-07-10
---

# F044 — 会话切换即时反馈 + 长会话按需加载

**Created**: 2026-07-10

## Why

小孙原话：

> “前端 切换会话的 还有点击的时候 总感觉有些卡顿的感觉 分析一下”

2026-07-10 真浏览器与运行态诊断确认：会话卡点击后要等完整房间快照返回才更新选中态；手机抽屉还要等请求完成才收起。当前最大房间已有 1178 条消息，切换接口一次返回 6.53 MB；前端随后全量重建 timeline、统计和 minimap（该房间生成 608 个导航按钮），使等待感随历史规模增长。

F009 已把实时消息主链改成增量快照，但“主动切换房间”仍走全量快照。本 Feature 是 F009 在真实数据规模增长后的可见续作。

## What

- 点击会话卡后立即显示目标选中/加载反馈；手机会话抽屉立即关闭，不再等待网络。
- 保持 `activeGroupId` 的 F031 可靠性语义：只有最新一次切换请求成功后才提交真实 active 状态；旧请求不能覆盖新选择。
- UI 切换接口只返回最新一页消息，历史消息用稳定游标按需向前加载；内部运行时的全量消息语义不变，原始数据不删不改。
- 长会话 minimap 有固定 DOM 上限，右侧统计避免对全文做重复扫描。

## Acceptance Criteria

- [x] **AC1 · 即时且竞态安全的切换状态**：点击非当前会话后，同一事件循环内写入独立 `pendingGroupId`；`activeGroupId` 只在最新请求成功后更新。重复点击当前会话不发请求，连续切换会取消/忽略旧请求，旧响应不得覆盖最新选择。
- [x] **AC2 · 手机点击反馈**：小于 768px 时，点击会话卡立即关闭左侧抽屉；目标卡显示 pending 状态，主时间线显示符合 `DESIGN.md` 的加载骨架。请求失败时保留原 active 会话并给出可恢复错误提示。
- [x] **AC3 · UI 专用消息窗口**：`GET /api/session-groups/:groupId` 默认最多返回最新 100 条 timeline 消息，并返回不透明游标与 `hasMore`；游标以 `createdAt + rowid` 稳定排序，同毫秒消息不丢不重。运行时内部 `getActiveGroup` / `listMessages` 的全量语义保持不变。
- [x] **AC4 · 历史按需加载**：时间线顶部可加载更早 100 条；新页与现有页按 message id 去重、时间顺序稳定，加载后保留用户阅读锚点，最终仍可访问完整历史。
- [x] **AC5 · 长会话前端减压**：minimap DOM 节点固定不超过 120，只有保留的 user marker 才执行摘要；状态统计改为单次遍历且不拼接整段 `content + thinking` 临时字符串。
- [x] **AC6 · 回归与浏览器证据**：单元/路由测试覆盖分页边界、同毫秒游标、重复点击、旧请求覆盖、分页合并和 marker 上限；Playwright 在隔离临时库上真点击验证即时反馈、手机抽屉和加载历史，且不触发真实 LLM。
- [x] **AC7 · 可靠性不回退**：F031 subscribe-before-fetch、wsWatermark baseline、delta/catch-up 测试保持通过；归档清 active、未读归零、decision/runtime-config 后续拉取行为不回归。

## Dependencies

- F009：增量快照与前端减压基础
- F031：会话切换期间的 WS seq/epoch + watermark 可靠性
- F038：隔离 Playwright E2E harness
- F039：`DESIGN.md` 与 SkeletonLines 视觉纪律
- F040：手机抽屉交互

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 即时反馈状态 | 提前改 active / 独立 pending | **独立 `pendingGroupId`** | 不破坏 F031 以 activeGroupId 过滤 WS 的语义 |
| 历史减载位置 | 全局截断 listMessages / UI 专用分页 | **UI 专用游标分页** | 避免重现“超过上限后最新消息消失”的历史 bug |
| 首屏窗口 | 50 / 100 / 200 | **100 条** | 将 1178 条大会话首载缩至约 8.5%，同时保留足够上下文 |
| 历史加载方式 | 自动顶端触发 / 明确按钮 | **顶部明确加载** | 可测、可恢复，不引入滚动观察器竞态 |
| minimap 上限 | 全量 / 聚合 120 | **最多 120** | 保留全程导航密度，消除数百按钮的 DOM 洪峰 |
| 视觉模式 | Overhaul / Preserve | **Preserve** | 不改 IA、路由、文案体系；只补状态反馈和按压反馈 |

Design Gate：小孙在诊断与上述修复优先级后回复 “go 往下推进吧”，确认按此方向实施。

## Quality Gate（2026-07-10）

**判定：PASS，可以进入独立验收。** 七项 AC 均有实现与自动化证据；愿景“切换不再让用户等网络才看到反应，同时不牺牲 F031 可靠性和完整历史”已覆盖。

| 指标 | 修改前 | 修改后 |
|------|--------|--------|
| 大会话首次切换载荷 | R201：1178 条、6.53 MB | 最多最新 100 条（约原消息数 8.5%），更早历史按 100 条分页 |
| 点击反馈 | 等 GET 完成，实测选中约 926 ms | 同一事件循环写入 pending；失败保留旧 active |
| 手机抽屉 | 等切换请求完成后关闭 | 点击即关闭，与请求完成解耦 |
| R201 minimap | 608 个导航按钮 | 固定不超过 120 个，保留 seal 并均匀采样 user marker |
| 状态统计 | 多次过滤并拼接全文临时字符串 | 单次遍历，不拼接全文 |

验证结果：

- `pnpm build`：通过；Next、shared 与 API TypeScript 构建完成。
- `pnpm typecheck`：通过。
- `pnpm lint`：0 error；73 条仓库既有 warning。
- `pnpm test`（rebase 到 `origin/dev` 后，Git Bash 置于 PATH 首位）：整体退出码 0；API/脚本 4046 tests（4044 pass / 0 fail / 1 skipped / 1 todo），组件 842/842 通过；10 万 session 分片与 8 条 `mount-skills` 外围脚本均通过。
- `pnpm test:components`：82 files / 842 tests 全通过。
- F044 后端专项（repository/service/routes/watermark）：72/72 通过。
- `pnpm exec playwright test tests/e2e/session-switch-performance.spec.ts`：3/3 通过（桌面即时反馈与重复点击、手机抽屉即时关闭、真实临时 SQLite 205 条消息分页耗尽与阅读锚点）；分页前后 minimap marker 索引从 `70 → 170 → 175` 重算，并真点击跳转第 25、175、0 条消息。使用隔离端口与临时 SQLite，不调用真实 LLM。
- `pnpm check:docs`：通过。

视觉证据说明：本次是 Preserve 模式，仅复用 `DESIGN.md` 既有骨架与 token，并把卡片动画从 `transition-all` 收窄为 transform；Playwright 已在 desktop/mobile viewport 验证关键状态。Codex 应用内浏览器本轮无法附着，因此没有伪造人工截图结论。

独立验收与审查：

- 零上下文 Acceptance Guardian：AC1–AC7 全部 ✅，判定 `PASS`；独立补跑 98 条前端专项、88 条后端专项与 205 条消息真实分页链路。
- Reviewer：Claude Code 2.1.206。r1 发现 2 个 P1 + 1 个 P2，修复后 r2 继续发现同房刷新零重叠窗口缺口；补 Red→Green 回归后 r3 判定 `GO — 可进入 merge-gate`。
- 小孙在隔离 preview `3105/8805` 体验会话切换、加载更早消息与右侧快速跳转后确认“应该没问题，继续往下推进”。
- merge-gate 增量验收补出 A→B→A 后旧历史页 `catch/finally` 污染新 A 状态：正式迁入 2 条 Red（旧错误污染、旧 finally 提前清 loading），以 `switchGeneration + groupId + cursor` 三元组守卫修复；专项 13/13、组件 842/842、Playwright 3/3 与全量 `pnpm test` 重新通过，等待最终独立复验签字。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | Kickoff；运行态诊断完成，Design Gate 通过 |
| 2026-07-10 | 实施计划完成；隔离 preview `3104/8804` 通过，进入 TDD |
| 2026-07-10 | TDD 实现完成；Quality Gate PASS，进入零上下文独立验收 |
| 2026-07-11 | 零上下文 Acceptance Guardian：AC1–AC7 全部 PASS；真实临时 SQLite 205 条消息分页与阅读锚点通过 |
| 2026-07-11 | Claude Code r1/r2 提出并复验竞态与连续窗口问题；修复后 r3 GO，0 个阻断 finding |
| 2026-07-11 | 小孙完成隔离 preview 体验并确认继续；补充分页后 minimap 真点击 E2E，红测命中、绿测 3/3 |
| 2026-07-11 | merge-gate 增量验收发现旧分页 catch/finally 竞态并 BLOCKED；两条反例正式 Red→Green，三元组守卫修复后全量回归通过，进入最终复验 |

## Links

- Plan: `docs/plans/F044-session-switch-performance-plan.md`
- Evolved from: F009
- Related: F031、F035、F038、F039、F040

## Evolution

- **Evolved from**: F009
- **Blocks**: 无
- **Related**: F031、F035、F038、F039、F040
