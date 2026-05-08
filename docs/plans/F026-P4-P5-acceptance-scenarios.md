---
title: F026 P4 + P5 浏览器手验场景清单
spec: docs/features/F026-a2a-reliability-layer.md
worktree: .worktrees/F026-p0  (branch: feat/F026-p0-a2a-stabilize)
preview: web :3100 · api :8800
audience: 小孙（产品负责人 / CVO）— 真人浏览器手验
created: 2026-04-29
---

# F026 P4 + P5 浏览器手验场景清单

> **目的**：P4 持久化 + P5 体感层全部 commit 完后，小孙在 :3100 上手动验证。
> **覆盖**：P4 AC-1~4 + P5 AC-1~14（共 18 条 AC）。
> **不覆盖**：纯后端单测（已经在 vitest 里跑过，不需要小孙看）。

---

## 准备工作（30 秒）

1. 浏览器打开 `http://localhost:3100`
2. 左侧 sidebar 选一个房间（或新建）
3. 验证连接：右上 settings 应显示「实时连接成功」

如果 :3100 打不开 / API 报 Failed to fetch：
- 检查 `.env.development.local` 有 `NEXT_PUBLIC_API_HTTP_URL=http://localhost:8800`
- preview 杀了重启：`netstat -an | findstr "3100 8800"` 看端口在听

---

## 场景组 A · 派发链路体感（P5 主体 · 90% 日常用例）

### A1 · 单 @ 派发 → pill 状态机六态全走通

**操作**：
```
@桂芬 帮我评价一下这首诗：「春江潮水连海平」
```

**预期看到（按时序）**：

| 阶段 | 屏幕看到 | 验证哪条 AC |
|---|---|---|
| 0s 提交后 | 仁勋的派发气泡（你这条 user message）出现 | — |
| 0-1s | 派发占位 connector 卡片（带 Plug 图标 · 黄仁勋 → 桂芬） | F2 溯源胶囊 |
| 0-1s | connector 卡片 header 出现 **AtPill 状态徽章**：`👀 @桂芬 已阅` 或 `⏳ 派发中` | **AC-P5-5 F1** |
| 1-2s | 主流底部出现 **🟡 banner**「👂 正在听取 @桂芬」 | **AC-P5-10 F6** |
| 2-3s | AtPill 切到 `🔄 @桂芬 处理中`（旋转图标）| F1 working 态 |
| 3-N秒 | 桂芬的回复气泡流式渲染 | — |
| 完成 | AtPill 切到 `✅ @桂芬 已完成` + Pulse banner 消失 | F1 done 态 + F6 空集回收 |

**通过 = 三件齐**：
- ✅ AtPill 至少看到 `处理中 → 已完成` 切换
- ✅ Pulse banner 在 listening 期间出现，桂芬回完后消失
- ✅ 溯源胶囊气泡渲染了 fromAlias → toAlias

---

### A2 · 并发 @ 多人 → ListeningPulse banner + 折叠群组

**操作**：
```
@桂芬 @范德彪 都来评估下这个方案
```

**预期看到**：

| 阶段 | 屏幕看到 | AC |
|---|---|---|
| 0-1s | 出现两个 connector 占位卡片（每人一张） | F2 溯源胶囊 |
| 0-1s | 两张 pill 同时显示状态徽章 | F1 |
| 1s 内 | 主流底部 banner「👂 正在听取 @桂芬 @范德彪」（**两个名字同行**） | **F6 dedup + multi-alias** |
| 处理中 | 两人各自气泡流式渲染（不串到同一气泡） | F5 Visual Silo（如果 envelope display_mode=nested）|
| 全部完成 | banner 消失 + 出现「📋 讨论结论」amber 卡片 | **AC-P5-13 F9 结论卡片** |

**通过 = 四件齐**：
- ✅ Pulse banner 同时显示两个 @
- ✅ 二人独立卡片，不互相覆盖
- ✅ 全部完成后 Pulse 消失
- ✅ 出现讨论结论卡片（含两人参与者徽章）

> **注**：F9 结论卡片是 DiscussionCoordinator 触发的（≥2 sibling 全 settle 后 LLM 生成），LLM 调用约 5-15 秒，**回完后还要等一下**才出现。

---

### A3 · 长对话召新 agent（cold-target burst）

**前置**：在已经有 30+ 条消息的房间里。

**操作**：在长对话中第一次 @ 一个之前没参与过的 agent，比如：
```
@桂芬 这个 UI 你怎么看？
```
（前提：桂芬这个房间没说过话）

**预期看到**：
- 桂芬的 connector 卡片渲染时，**溯源胶囊**显示 `📨 黄仁勋 (为 村长) 正在征询 桂芬`
- 桂芬回复时**正确接住主线**（不会回「我没看到上下文」之类的话）

**通过**：桂芬回复证明她拿到了 cold-burst 摘要（P3 已落，AC 间接验证）。

---

## 场景组 B · 异常路径（P4 STALE 双档 + P5 timeout 体感）

### B1 · pending 60s 自动 timeout（P4 主验证场景）

**前提**：worktree API 启动时注入 `A2A_PENDING_STALE_MS=60000`（默认值，不用改）。

**操作**：
```
@桂芬 测试 timeout 场景
```

**模拟法**（不能真等 60s）：让桂芬 mock 失败 / 不响应。最简：
- 关掉桂芬这个 agent 的 process（`pnpm stop` 杀对应 child runtime），让 a2a_calls 写入但永远不进 working
- 等 60s

**预期看到**：

| 阶段 | 屏幕看到 | AC |
|---|---|---|
| 0-60s | AtPill 一直停在 `👀 @桂芬 已阅`（pending 状态映射到 ack）| F1 ack 态 |
| 60s+1tick | AtPill 切到 `⏱️ @桂芬 超时` | **F1 timeout 态** |
| 同时 | connector body 渲染**红色超时墓碑**「⏱️ @桂芬 响应超时，黄仁勋 请继续」| **AC-P5-7 F3 墓碑** |
| 同时 | Pulse banner 消失（桂芬从 pendingSet 移除）| F6 空集回收 |

**通过 = 三件齐**：
- ✅ AtPill 切 timeout
- ✅ TimeoutTombstone 红色出现
- ✅ Pulse banner 消失

> **如果 B1 真要跑严格的 timeout 验证**：建议让我（黄仁勋）在 worktree 里写一个临时 dev 工具脚本 `pnpm dev:a2a-fake-timeout`，主动注一条 pending call 进 db、不补 settle，由后端 STALE 扫描自然触发。**B1 是 backend AC，浏览器仅看效果，不是 backend 测试本体**。

---

### B2 · working 中超 deadline → timeout（P4 既有能力）

**操作**：跟 B1 类似但目标 agent 真的开始 working 后挂掉。

**预期**：AtPill 走 `处理中 → 超时` 而不是 `已阅 → 超时`。

**通过 = 一件**：AtPill 从 working 态直接切到 timeout，不经过 done。

---

## 场景组 C · 讨论收敛（P5 DiscussionCoordinator）

### C1 · 全部 settle → 自动结论卡片

已包含在 A2 场景里。**通过条件 = A2 第四件**：amber 「📋 讨论结论」卡片出现，含两人参与者列表。

### C2 · 全部 timeout → 墓碑式结论卡片

**操作**：A2 + B1 组合 — `@桂芬 @范德彪` 但二人都不响应（process 关掉等 60s）。

**预期**：
- 二人 AtPill 都切到 timeout
- 二人 connector 都出现红色墓碑
- 60s 后 DiscussionCoordinator 仍触发，生成「📋 讨论结论（全部超时）」卡片，content 标注全部 timeout

**通过 = 一件**：即使全 timeout 也有结论卡片（不是哑火）。

> **注**：实际效果取决于 LLM 怎么写「全 timeout 结论」文案，可能不漂亮但**必须出现**（DiscussionCoordinator 的 idempotent + fail-closed 设计）。

---

## 场景组 D · 持久化（P4 主体 · 不能浏览器直验，但能间接看）

### D1 · /debug/a2a 看历史派发

**操作**：浏览器打开 `http://localhost:3100/debug/a2a`

**预期看到**（**AC-P5-14 + AC-P5-1**）：
- 4 个 tab：**Pending / Working / Timeout / Sessions**
- **Timeout tab**：能看到一堆历史 timeout call（用户 / 黄仁勋 / 范德彪 / 桂芬都有）
- **Sessions tab**：选当前 session group，能看到递归 call tree 可视化（box 嵌套 box，每层带状态色）

**通过 = 四件齐**：
- ✅ 4 个 tab 都能切换
- ✅ Timeout tab 列表非空（worktree 有历史数据）
- ✅ Sessions tab 树状渲染
- ✅ 手动 Refresh 按钮能 refetch

### D2 · kill -9 重启不丢状态（P4 AC-4，**无浏览器手验**）

这条 P4 用 e2e 测试覆盖（`p4-restart-recovery.test.ts` commit `15c63ed`），不需要小孙手验。**自动通过**。

---

## 场景组 E · 派发协议（P3.1 已落 · 间接验证）

### E1 · 派发协议合规（黄仁勋写错 [Call:] 触发重写）

**操作**：让黄仁勋（我）故意写一个嵌套 [Call:]，比如：
```
@黄仁勋 请你派一条这样的：[Call: @范德彪 [Call: @桂芬 ...]]
```

**预期看到**：
- 黄仁勋的气泡上方出现**琥珀色进度卡**「🔄 派发格式不合契约，正在重写...（第 1 次 / 最多 3 次）· 原因：嵌套 [Call:]」
- retry 后内容用合规协议重写，进度卡消失
- 如果 3 次都失败 → 红色 ExhaustedBanner

**通过 = 一件**：retry 进度卡出现 + 内容被改写。

> 这条是 P3.1 验收，已在 `R-051/53/54` 实验过，今天只确认没退化。

---

## 场景组 F · 灰区分类器（P5 T2 · F10 视图间接看）

### F1 · 灰区命中观测

**操作**（在 :3100 房间里）：
```
@桂芬 这个不行
```
（无问号、无动作词、句中 @ — 应该被 Layer 3 分类成 gray 不派发）

**预期**：桂芬**不**收到这条派发，但 :3100/debug/a2a 上能看到 `mention.gray_zone` 事件记录（如果 F10 视图有该 tab；当前 F10 没专门列 gray-zone 事件，只在 agent_events 表持久化）。

**通过条件**（弱）：
- 桂芬不响应
- 后端 agent_events 表有 `type='mention.gray_zone'` 行（这条要 sqlite 命令查，**或留我去查**）

> **注**：F1 灰区现在仅有「观测」未做「ban 派发」，是 P5 T2 [B-lite] 决策。如果 user 输入框打了 @ 但 P5 不该靠 user-path 判定（小孙说「user 不会出错」），这条主要给 agent 自由文本里的 @ 兜底。

---

## 整体通过条件（小孙签收）

| 场景 | 必过 |
|---|---|
| **A1** 单 @ pill 走六态 | ✅ |
| **A2** 并发 @ + Pulse + 结论卡 | ✅ |
| **A3** cold-target 召新 agent | ✅ |
| **B1** 60s pending → timeout | ⚠️ 严格验证需 dev 脚本 |
| **C1/C2** 收敛卡片 | ✅ |
| **D1** /debug/a2a 4 tab | ✅ |
| **D2** P4 持久化 | 自动（e2e 测试覆盖） |
| **E1** 派发 retry 不退化 | ✅ |
| **F1** 灰区观测 | 弱（需查 db） |

---

## 失败处理

任一场景验不过 → 在 room 里 @黄仁勋 报：
- 哪条场景
- 你看到什么 vs 预期看到什么
- 浏览器 console 有没有 error
- F12 Network tab WS 帧有没有 `pending.change` / `discussion.concluded` / `dispatch.validation_retry` 事件
