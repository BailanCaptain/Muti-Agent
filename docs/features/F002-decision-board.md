---
id: F002
title: Decision Board — 讨论级拍板收敛
status: done
owner: 黄仁勋
created: 2026-04-10
completed: 2026-04-11
---

# F002 — Decision Board：讨论级拍板收敛

**Status**: spec
**Created**: 2026-04-10

## Why

当前 `[拍板]` 机制在 A2A 讨论场景下有三重破坏性问题，已经影响到小孙和团队的实际使用体感：

1. **决策被静默吞掉**（原 B003 报告的现象）
   - `detectAndEmitInlineConfirmations` 生成的 requestId 从未登记进 `DecisionManager.pending` Map
   - 用户点拍板按钮 → 前端发 `decision.respond` → 后端 `pending.get` 返回 undefined → 第二行就 `return`
   - 决策不写 thread、`decision.resolved` 不广播、agent 永远不知道用户做过选择
   - 小孙的体感："点了拍板，下次 agent 启动什么都没看到"

2. **多 agent 决策不收敛**
   - Agent A 抛 `[拍板] X`，agent B 同时抛 `[拍板] X`（同一个问题不同表述）
   - 用户被迫回答两次，后端即便修好 Break 1，也会两次 `runThreadTurn` 把 A 和 B 都叫醒
   - A2A 的"一对多→收敛到一个 @ 目标"规则被打破，讨论节奏乱掉
   - 类比：两个人讨论途中同时跑出去找产品，产品答完两人各自回来独立继续，discussion thread 分叉

3. **讨论中可被消化的问题依然打扰用户**
   - 范德彪抛 `[拍板] A、B`，桂芬抛 `[拍板] C`
   - 接下来俩人继续讨论，发现 A 有现成答案、C 是伪命题，只有 B 真的需要拍板
   - 当前行为：用户仍会看到 A/B/C 三张卡片 → 回答 2 个假问题
   - 正确行为：讨论自然消化了 A 和 C，用户只应该看到 B

这三个问题共同指向一个更深的语义错配：**`[拍板]` 在 A2A 里不是 inline 动作，而是 meta 动作**。inline 卡片"立刻弹出、立刻响应"的 UX 在单 agent 场景 OK，在多 agent 讨论场景就是"打断讨论去找 PM"，破坏 A2A 收敛语义。

### 为什么不走 bug fix 路径

B003 最初按 bug 处理，探索后发现：
- 最小修（仅补 pending 登记）只解决问题 1，不解决 2 和 3
- 中等修（Option C：单点 dispatch）解决 1 和 2，不解决 3，且 UX 仍是"实时弹卡"
- 要同时解决三个问题 → 需要引入 "Hold → Settle → Flush → Single Dispatch" 的新模型 + 前端批量卡片 UX

后两项改动在 ~300 行量级，涉及新的运行时状态机（DecisionBoard）、新的前端面板组件、agent prompt 约定扩展（`[撤销拍板]`）。按"小孙能感知变化 → feature"的分类标准，升级为 feature。

## What

引入 **Decision Board** 运行时模型，把拍板从"inline 即时卡片"改造成"讨论级收敛的批量面板"。

### 用户感知到的变化

- **讨论活跃期**：agent 在输出里写 `[拍板] …` 时，前端**不再立刻弹卡**。用户看到的是 agents 正常讨论，就像两个同事在白板前争论、偶尔说"这个得问下产品"并把便签贴到白板上。
- **讨论自然停下**：当前 session 没有 running ParallelGroup、dispatch queue 空、无 agent turn 运行时，后端判定"settle"，把 Decision Board 上剩下的所有条目**一次性**推给前端。
- **批量面板**：前端显示一个聚合面板（不是多个零散卡片），里面按"问题"分组展示，每个问题写明：
  - 问题文本
  - 选项列表
  - **谁提的**（支持多 agent 共同提出 → "范德彪和桂芬都问到"）
  - 选项按钮
- **用户一次性答完**：用户在这个面板里对所有问题做出选择，提交。
- **单点收敛 dispatch**：后端把所有答案合成**一条汇总消息**，只 dispatch 给**一个** agent（规则见 AC5），让那个 agent 醒来继续推进，必要时 `@` 队友同步。A2A 单点收敛保持。
- **撤销能力**：agents 可以在讨论中通过 `[撤销拍板] 问题文本` 从 Board 上移除自己之前提的条目，表达"这个问题我们讨论后不用问产品了"。被撤销的条目不会在 settle 时出现在面板上。

### 用户不感知但关键的变化

- 新增 `DecisionBoard` 状态机：持有 session 级别的 pending decision 集合，支持 add/dedupe/withdraw/flush
- `DecisionManager.respond` 增加对 inline 路径的支持（Break 1 修复，也是这个 feature 的副产品）
- 新增 `SettlementDetector`：监听 ParallelGroup / dispatch queue / agent turn 三类事件，判断"讨论是否已停"
- 新增 `[撤销拍板]` parser 扩展和 agent system prompt 条款
- 前端新增 `<DecisionPanel>` 组件替代当前的 inline confirmation 卡片

## Acceptance Criteria

### 核心收敛语义

- [x] **AC1 — 决策落地**：用户在批量面板点完提交，对应 agents 的 thread 里能看到 "产品已就以下问题给出决策：…" 的汇总消息写入（`role: user`）。DB 可验证。
- [x] **AC2 — Hold 不弹卡**：agent 在讨论活跃期（ParallelGroup running 或 dispatch queue 非空）输出 `[拍板]` 时，前端**不**收到 `decision.request` 事件，没有卡片弹出。
- [x] **AC3 — Settle 后批量弹**：当 session 达到 settle 条件（无 running group + 空 dispatch queue + 无 running turn）时，Board 上所有 pending 条目**在一次** WebSocket 事件里推给前端，前端显示**一个**批量面板。
- [x] **AC4 — 同问题 dedupe**：两个不同 agent 抛出文本相似度高的 `[拍板]`（通过归一化 hash），Board 合并为一条，raiser 列表包含两个 agent。用户只看到一个选项组。
- [x] **AC5 — 单点 dispatch 收敛**：用户在批量面板里同时决定了 N 个问题（可能来自不同 agent 的不同 thread），后端只触发 **1 次** `runThreadTurn`，target 是 A2A 讨论链起点 agent（ChainStarterResolver 锁定），triggerMessageId 是合成汇总消息 ID。其他 agent 不会被自动叫起。
- [x] **AC6 — 撤销生效**：agent 在 settle 前输出 `[撤销拍板] 问题文本`，该条目从 Board 上消失。若所有条目都被撤销，settle 时 Board 为空，**不**弹任何面板，用户全程无打扰。
- [x] **AC7 — MCP `request_decision` 路径不回归**：已有的 MCP 同步决策路径（blocking Promise）行为不变，`decision-manager.test.ts` 回归测试全绿（P2.T5）。不允许"修 A 挂 B"。

### 前端批量面板 UX

- [x] **AC8 — 面板聚合显示**：批量面板顶部写明"团队讨论已收敛，以下 N 个问题需要你拍板"，下面按问题顺序列出，每个问题卡片含：问题文本、raiser 列表（ProviderAvatar 头像+昵称 badge）、选项 radio。
- [x] **AC9 — 未决前不可忽略**：面板出现后不允许静默消失，只能通过 ✕ / "暂不回答"（语义：写入"产品暂未决定"+ 单点 dispatch）或"提交决策"关闭。
- [x] **AC10 — 提交前可修改**：受控 zustand state，用户可以在面板内反复切换选项或切到"其他（自由输入）"，只有点"提交决策 →"按钮后才 POST 落地。
- [x] **AC11 — 不破坏 F001 UI 焕新风格**：Decision Board 是独立 `<DecisionBoardModal />` 组件，不动 TimelinePanel / Composer / 消息渲染体系。庄严视觉与 F001 message 样式互不干扰。

### 工程质量

- [x] **AC12 — 无 hold 超时**：`SettlementDetector` 实现中无 timeout / maxHoldMs 字段，Board 只在 3-AND settle 条件满足时 flush。
- [x] **AC13 — Settlement 事件 debounce**：`SettlementDetector` 默认 2000ms debounce re-arm（`settlement-detector.test.ts` 覆盖）。
- [x] **AC14 — 测试覆盖**：`decision-board.test.ts` / `settlement-detector.test.ts` / `chain-starter-resolver.test.ts` 单测全绿；`message-service.test.ts` 端到端测了 Board 并入 / flush 事件 / handleBoardRespond / 跳过语义。280/283 API 测试通过（3 failed 与 F002 无关，dev 分支已存在）。
- [x] **AC15 — Break 1 修复**：`detectAndEmitInlineConfirmations` 已改为 `board.add`（P2.T2），所有 inline `[拍板]` 100% 进 Board；MCP 路径保持走 `DecisionManager.request()`。两条路径终端接入同一个前端决策 UX 层级，运行时完全分离。

### Vision Triage（P3 完工愿景对照）

| 小孙原话（逐字引用） | 交付物证据 | 匹配 |
|---------------------|----------|------|
| B003："点了拍板，下次 agent 启动什么都没看到" | `handleDecisionBoardRespond` 写 user message + `registerUserRoot` + `runThreadTurn` — `message-service.ts:handleDecisionBoardRespond`，`message-service.test.ts` 覆盖 | ✅ |
| "两个人讨论途中同时跑出去找产品……discussion thread 分叉" | `ChainStarterResolver` 锁定 hopIndex=0 最早 assistant → 单点 dispatch 回讨论链起点，`chain-starter-resolver.test.ts` | ✅ |
| "只有 B 真的需要拍板（A/C 应该被消化）" | `[撤销拍板]` parser + `board.withdraw`，P2.T1 / P2.T2 | ✅ |
| "我无所谓要等多久，重要的是能收敛" | `SettlementDetector` 无 timeout 字段；AC12 自验 | ✅ |
| "单个单个的卡片太难看了" | `DecisionBoardModal` 批量卡片聚合渲染 | ✅ |
| "更庄严好一点" | 深墨蓝 `#0E1A2E` + 金线 `border-amber-500/40` + serif 3xl 编号 + slideUp 220ms | ✅ |
| "可以改成都不选可以输入别的决策" | "其他（你来写）" radio + autoFocus textarea | ✅ |
| "应该回给 A2A 的发起者（需要收敛的那个人）" | ChainStarterResolver 规则 = 讨论链起点，AC5 证据 | ✅ |
| "500ms 可以再长一点 宁愿安全都不愿意弹错了" | debounce 2000ms 默认（AC13） | ✅ |
| "不接受张冠李戴风险" | 正则归一化 + SHA-1 精确 hash（非 embedding），`decision-board.ts` | ✅ |

## Dependencies

- **F001（UI 焕新）**：批量面板的视觉语言依赖 F001 交付的组件体系。F001 已 merge（commit `43c7eda`），可用。
- **B001 WebSocket 容错**：Board flush 依赖 WebSocket emit 可靠，B001 修复已合入（commit `6a9814e`）。
- **运行时 ParallelGroupRegistry**：settle 判定需要读 registry 状态。已有，不改。
- **运行时 Dispatch Queue**：settle 判定需要读 queue 长度 / slot 忙闲。已有，不改。

## Design Decisions

### A. 立项策略

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| B003 走 bug 还是 feature | A: bug 最小修 / B: Option C 单点 dispatch / C: 升级为 feature 走完整 Decision Board | C | 小孙明确选 (a)。单修不能解决多 agent 收敛和讨论消化两个深层问题，继续小修会累积语义债 |
| Hold 超时 | A: 设硬超时（3min/5min）兜底 / B: 不设超时，纯靠 settle 信号 | B | 小孙原话："我无所谓要等多久，重要的是能收敛"。设超时会破坏"讨论消化问题"的批量性 |
| 弹卡形态 | A: 继续 inline 单卡 / B: 批量聚合面板 | B | 小孙原话："单个单个的卡片太难看了"。批量面板也是 A2A 收敛语义的自然外化 |

### B. 批量面板 UX（小孙 Design Gate 确认）

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 面板呈现方式 | modal 浮层 / 侧边抽屉 / thread 内嵌卡片 | **modal 浮层（全屏半透明遮罩 + 居中面板）** | 小孙选 (a)，强中断符合"决策时刻"的仪式感 |
| 第三选项形态 | "让我想想先跳过" / "其他（自由输入）" | **自由输入框**（选项 A / B / 其他，选"其他"展开输入框） | 小孙原话："可以改成都不选可以输入别的决策"。强制用户做出明确决定，但不限于预设选项 |
| 关闭 ✕ 语义 | a: 撤销本次 flush，下次 settle 再弹 / b: 写入"产品暂不回答"context 并触发单点 dispatch / c: 完全丢弃 | **b** | 小孙选 (b)。决策不丢、agent 获得 context、仍触发单点 dispatch 让 agent 继续推进 |
| 问题分组展示 | 按 raiser 分组 / 按问题顺序聚合 | **聚合展示但每题标注 raiser 头像+昵称** | 小孙原话："放在一起 但是要能展现出是谁提出的 问题头像等等" |
| 视觉基调 | 跟 F001 普通 message 一致 / 独立"庄严"语言 | **独立庄严视觉语言** | 小孙原话："更庄严好一点"。决策时刻要跟日常讨论明显区别 |
| 视觉主色 | 深墨蓝 `#0E1A2E` / 深棕黑 `#1A1613` / 其他 | **深墨蓝 `#0E1A2E` + 暖金线 `#C9A876`（边框/编号）** | 小孙授权我选，原话"不要太突兀就可以"。深墨蓝在 modal 场景既有仪式感又不刺眼，暖金避免冷色堆叠 |
| "暂不回答"触发的 agent 唤起 | 前者：仍触发单点 dispatch / 后者：不 dispatch，等下次 @ | **前者**（仍 dispatch） | 小孙选前者。agent 拿到"产品暂不决定"后主动继续推进，而非被动等待 |

### C. 后端契约（黄仁勋单人探索 Mode A）

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| Dedupe 策略 | 文本归一化 hash / agent 显式 decisionId / embedding 相似度 | **正则归一化后精确 hash 匹配**（小写化 + 去标点空白 + 去"是否/还是/要不要"等填充词 + SHA-1 前 8 位） | 小孙原话："不接受张冠李戴风险"。embedding 误合并风险大于 hash 漏合并风险；批量面板 UX 允许两张相似卡相邻呈现 |
| 单点 Dispatch Target | 最早 raiser / 最晚 raiser / 讨论段最近说话者 / A2A 链起点 agent | **A2A 讨论链起点 agent**（= 任务所有者） | 小孙原话："应该回给 A2A 的发起者（也就是需要收敛的那个人）"。链起点 = 任务所有者 = 真正需要答案推进的人。具体判定：在当前 session 最近一条 user 消息触发的 A2A 链里，找 `hopIndex === 0` 且 `createdAt` 最早的 assistant 消息，其 threadId 即 target |
| 撤销语法 | `[撤销拍板] <子串>` / `[撤销拍板 D<id>]` / 模糊匹配跨 raiser | **`[撤销拍板] <子串>`，模糊子串匹配，仅限 raiser 撤自己的** | Agent 看不到 Board state 拿不到 ID，语法需要基于 agent 自己的记忆；禁止跨 raiser 撤销避免一方越权；多匹配时撤最新一条 |
| Settle 信号源 | 单信号 / 多信号 AND / 多信号 OR | **三 AND 条件** — (1) `parallelGroupRegistry.hasActiveGroup === false` AND (2) `dispatch.queueSize === 0` AND (3) `messageService.hasRunningTurn === false` | 任一为真都意味着讨论还在进行中，必须三者同时为假才能判定"真的停了" |
| Settle Debounce 时长 | 500ms / 1000ms / 2000ms / 3000ms | **2000ms 默认**（可配置） | 小孙原话："500ms 可以再长一点 宁愿安全都不愿意弹错了"。2000ms 是 agent turn 切换典型间隙（50-200ms）的 10-40 倍裕度，人类感知上仍无差别 |
| MCP `request_decision` 与 Inline 路径整合 | 汇入同一 Board / 保持两条独立路径 | **保持独立**。MCP 继续走 `DecisionManager.request()` 同步 blocking；Inline 走 Board | 若 MCP 也走 Board 会死锁（MCP agent 正在 turn → hasRunningTurn=true → 永不 settle → Board 永不 flush → agent 永远等）。两者语义本质不同：MCP = "阻塞要答"，Inline = "顺手标记可延迟" |
| MCP + Board 前端并存 | modal 优先 / inline 优先 / 队列化 | **modal 优先覆盖** | 批量面板是讨论 settled 后的"决策时刻"，优先级更高；MCP 卡片在底下等待（反正 MCP agent 本来就在 block，多等几秒不影响） |

### 最终 Wireframe（文字版）

```
╔═══════════════════════════════════════════════════════════╗
║  ⬛ 全屏半透明遮罩（#000 @ 60%，模糊背景）                   ║
║                                                           ║
║    ┌─────────────────────────────────────────────────┐    ║
║    │ ◆ 产品决策时刻                               ✕  │    ║
║    │   (Source Han Serif，衬线，#C9A876 暖金)         │    ║
║    │ ─────────────────────────────────────────────── │    ║
║    │ 团队讨论已收敛，以下 N 个问题需要你拍板            │    ║
║    │                                                 │    ║
║    │ ╭─────────────────────────────────────────────╮ │    ║
║    │ │ 01 (金属字大号编号 #C9A876)                 │ │    ║
║    │ │                                             │ │    ║
║    │ │ {问题文本，加大 1 号}                        │ │    ║
║    │ │                                             │ │    ║
║    │ │ 提出者  (头像)(头像)  范德彪、桂芬            │ │    ║
║    │ │                                             │ │    ║
║    │ │  ○ A) {选项 A}                               │ │    ║
║    │ │  ○ B) {选项 B}                               │ │    ║
║    │ │  ○ 其他（你来写）                            │ │    ║
║    │ │    ┌─────────────────────────────────────┐  │ │    ║
║    │ │    │ 输入你的决定...（选中"其他"才展开）   │  │ │    ║
║    │ │    └─────────────────────────────────────┘  │ │    ║
║    │ ╰─────────────────────────────────────────────╯ │    ║
║    │ {...更多问题卡片}                                │    ║
║    │ ─────────────────────────────────────────────── │    ║
║    │            [ 暂不回答 ]   [ 提交决策 → ]         │    ║
║    └─────────────────────────────────────────────────┘    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

背景色:   modal 内部 #0E1A2E (深墨蓝)
边框:     1px 细线 #C9A876 (暖金), 外发光 blur 8px
编号:     Source Han Serif, 32px, #C9A876
问题文本: 16px, 白色 #F5F5F0
选项:     14px, 浅灰 #C8C8C0, hover #FFFFFF
动画:     modal fade-in 200ms + 从下缓入 24px; 遮罩淡入 150ms
```

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-10 | B003 从 bug 探索中浮现深层问题（多 agent 收敛、讨论消化），决定升级为 feature |
| 2026-04-10 | Kickoff — F002 Decision Board |
| 2026-04-10 | Design Gate 通过 — UX 7 项（小孙确认）+ 后端契约 7 项（黄仁勋 Mode A 单人探索） |
| 2026-04-11 | P1 完工 — DecisionBoard / SettlementDetector / ChainStarterResolver 三个纯模块 TDD 落地 |
| 2026-04-11 | P2 完工 — MessageService 改造、flush/respond 路由、MCP 回归测试（AC7） |
| 2026-04-11 | P3 完工 — DecisionBoardModal + zustand store + WS 事件路由 + 手动 E2E 清单 |
| 2026-04-11 | Status → done（AC1-AC15 全核，愿景三问通过） |

## Links

- Discussion: Design Gate 决策留存于本聚合文件 Design Decisions 章节
- Plan: [F002 Implementation Plan](../plans/F002-decision-board-plan.md)
- Related: F001（UI 焕新，提供视觉基座）
- Supersedes: 原 B003 bug 报告（已删除，问题 1 作为 AC15 吸收进本 feature）

## Evolution

- **Evolved from**: 无（独立新 feature，但吸收了 B003 调查结论）
- **Blocks**: 无
- **Related**: F001（视觉基座依赖）
