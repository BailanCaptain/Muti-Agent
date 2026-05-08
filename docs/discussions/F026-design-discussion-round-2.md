---
title: F026 A2A 可靠通信层 · Round 2 架构讨论收敛
status: approved-2026-04-23 · Design Gate 已拍板（小孙 D1/D4/D6 全接受）
feature: F026
convener: 黄仁勋
round: 2
discussants: 范德彪（Codex · 协议模型层） / 桂芬（Gemini · UX + 前端契约 + SOP） / 小孙（愿景）
created: 2026-04-23
approved_at: 2026-04-23
approved_by: 小孙
approved_decisions:
  - D1 · Q1-Q6 + Q12 收敛提案整体接受
  - D2 · 十一条不变量（I1'-I11）编号体系采纳（默认 A）
  - D3 · Phase 拆分改动采纳（默认 A）
  - D4 · ADR-002/003/004 放行落 worktree docs/adrs/
  - D5 · LL-028/LL-029 落 lessons-learned.md（默认 A；编号跳过被越位的 026/027）
  - D6 · 淡紫色 A2A 密谋区底色采纳
落盘产物:
  - spec v2 · docs/features/F026-a2a-reliability-layer.md
  - ADR-002 · docs/adrs/ADR-002-a2a-call-tree-truth-source.md
  - ADR-003 · docs/adrs/ADR-003-a2a-mention-router-three-layer.md
  - ADR-004 · docs/adrs/ADR-004-a2a-transparent-to-agent.md
  - Phase 1 plan · docs/plans/F026-phase1-plan.md
  - LL-028 / LL-029 · docs/lessons/lessons-learned.md
---

# F026 A2A Round 2 · 架构讨论收敛报告

> **这份文件是 convener 草稿，不是决议。** 小孙拍 Design Gate 后再落 ADR / lessons-learned / SOP 三件套。
> **权限边界**：Round 1 已把 F026 spec 从「症状统计 + clowder 逆向」翻到「愿景 A · 逐级收敛 + 独立卡片 + 结构化交接」。Round 2 讨论的是**在新愿景下**协议模型、@ 识别、Envelope、隔离、收敛权应该怎么定。

---

## 一、Round 2 讨论侧状态（证据档）

| 视角 | 人 | 产出 | 证据位置 |
|---|---|---|---|
| 愿景层 | 小孙 | 7 个场景口述 + 「逐级收敛 / 不互相污染 / 听到所有人的话 / 结构化交接」四条愿景 | Round 1（room 09:19-09:30） |
| 协议模型层 | 范德彪（Codex） | Q1-Q6 立场 + 代码锚点（`a2a-chain.ts / return-path.ts / parallel-group.ts / settlement-detector.ts`） | room 11:35（第 29 条） |
| UX / 前端契约 / SOP | 桂芬（Gemini） | R1 五条 UX 原语（溯源胶囊 / 意图嗅探 / 超时墓碑 / 折叠群组 / Mode C 三件套） + R2 Envelope 字段（parentCallId / displayMode / onBehalfOf） + Q12 分歧点 | room 11:40（R1） + 11:43（R2） |

**讨论成熟度判断（convener）**：三方视角齐、Q1-Q6 + Q12 都有独立立场、关键议题上范德彪与桂芬**独立撞点**（见 §三 共识点）。**再叫人边际收益递减**，进入收敛。

---

## 二、逐条收敛提案（Q1-Q6 + Q12）

### Q1 · 协议真相源：worklist/return-path vs call tree / pending set / join

| 方 | 立场 |
|---|---|
| 范德彪 | **(b) call tree + pending set + join** 作为权威协议模型。理由（代码证据）：`a2a-chain.ts:3-12` 只有 `parentInvocationId/rootMessageId/sessionGroupId`——表达不了「谁收敛/还欠谁/这次替谁叫人」；`parallel-group.ts:39-70` 的 `pendingProviders/completedResults/aggregating` 其实就是 join 雏形；`settlement-detector.ts:26-68` 按 sessionGroupId 判 settle = 最小粒度是会话，不是调用树 |
| 小孙愿景 | 「由提出方收敛」+「逐级收敛（无论中间过多少轮）」= call tree 语义 |
| 桂芬 | 通过 `parentCallId` / `rootRequester` 字段表达（和 Q1(b) 结论一致，从 UX 侧撞点） |

**收敛提案**：采纳 **(b)**。F026 spec 新的协议真相源锁死为 **Call Tree + Explicit Convener + Pending Set + Join**。底层实现要用 queue/worklist 只是执行器细节，不再当协议中心。

**对现行 F026 spec 的影响**：
- I2 「Worklist 续推」原为不变量 → **降级为实现手段**（写进 Phase 2 执行注释，不再是 AC 层）
- 新增不变量 **I7 · Call Tree 贯穿**（call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of 全链路）
- Design Decisions 表第 1 行「抄 clowder worklist 续推 = 全抄 A」**结论保留但定位调整**：抄的是 worklist 的**执行机制**，不是协议模型

---

### Q2 · @ 识别策略（S3 · 介绍 vs 召唤）

| 方 | 立场 |
|---|---|
| 范德彪 | **(d) 混合 + fail-closed**。三层：hard-negative（code block/quote/装饰性名册 一票否决） → hard-positive（行首 @ + 指令语义 + 明确动作对象 直接派） → 灰区轻量分类器（低置信度默认不派，只记 debug） |
| 桂芬（R1） | **意图嗅探**：行首 `@` → 派发；文中 `@` → 仅高亮；UX 差异（任务中⚡️角标 vs 普通链接） |
| 小孙愿景 | 「A2A 应该和人说话一样」、「agent 不一定遵从 prompt」（Round 1 场景 3） |

**独立撞点 · 强信号**：范德彪「hard-positive 行首 @」和桂芬「意图嗅探 行首 @ vs 文中 @」**从两个完全不同的视角独立收敛到同一条规则** —— 这是 Q2 最高置信度的产出。

**收敛提案**：采纳范德彪三层方案 + 桂芬 UX 映射：

| 层 | 判定 | 运行时动作 | 前端渲染 |
|---|---|---|---|
| 1. hard-negative | code block / blockquote / 装饰性名册 / 介绍句式 | **一票否决不派** | 普通 @ 链接 |
| 2. hard-positive | 行首 @ + 指令/请求语义 + 明确动作对象 | **派发** | ⚡️ 任务中角标 |
| 3. gray-zone | 灰区进轻量分类器 | **默认不派**，只记 debug，可选 UX 问 issuer「是派发还是提及」 | 弱提示 |

**对现行 F026 spec 的影响**：
- 原 I1 「AgentRef + Markdown-AST mention」升级为 **I1' · 三层 fail-closed 识别**
- 症状 S3（介绍 vs 召唤）从 Round 1 「还没定」→ 定案
- **现场实证（Round 2 自带）**：11:41:31 → 11:43:12 的级联事故 = 正文 code block 里的 `@桂芬` 被旧 mention-router 误派。F026 在 Round 1 已识别这个漏洞（I1 原文），Round 2 的 I1' 要**扩展到 blockquote、装饰性名册、代码 fence**三类硬否决，并在 Phase 1 的回归用例里直接收这次事故的 reproducer

---

### Q3 · Envelope 字段分层

| 方 | 立场 |
|---|---|
| 范德彪 | Envelope 拆两层：**protocol** `{call_id, parent_call_id, root_call_id, issuer_id, convener_id, on_behalf_of, reply_to, deadline}` + **task** `{task, input, expected_output, constraints, context}`。`Burst/Tombstone/rollingSummary` 归 `task.context` 不是路由头 |
| 桂芬 | Envelope 前端契约：`parentCallId / displayMode(inline/nested/background) / onBehalfOf` |
| 小孙愿景 | 「结构化的传入信息，不是直接原文灌」（Round 1 场景 7） |

**收敛提案**：采纳范德彪两层 schema，桂芬 UX 字段作为 **render hints 子层**：

```ts
protocol: {
  call_id, parent_call_id, root_call_id,
  issuer_id, convener_id, on_behalf_of, reply_to,
  deadline
}
task: {
  task, input, expected_output, constraints,
  context: { burst, tombstone, rolling_summary },
  render: { displayMode: 'inline' | 'nested' | 'background' }   // 桂芬 UX 契约
}
```

- schema **必须版本化**（范德彪明确提）
- `displayMode` 放 `task.render` 是因为它影响前端呈现不影响路由决策
- **收敛权归属**由 `convener_id` 显式决定，不由 `parent_call_id` 嵌套推导（见 Q5）

**对现行 F026 spec 的影响**：
- 新增不变量 **I8 · Envelope 双层 + 版本化**
- 现行 I11（`{task, input, on_behalf_of, expected_output, constraints}`，若 spec 里有此条）需改为上述两层

---

### Q4 · 横向静音 · 兄弟隔离

| 方 | 立场 |
|---|---|
| 范德彪 | 以 **`parent_call_id / join_set_id`** 为边界，不用 message tag。**默认不允许 sibling 直聊**；A 真要问 B 就建新 child call：A 为自己求助 `convener=A`；A 代表 caller 拉 B `issuer=A, convener=caller` |
| 桂芬 | **并列卡片 + Visual Silo**：B 只能看到 A 给它的 `taskSnippet`，看不到 A 给 C 说了什么；B 和 C 的输出独立卡片、独立跳动 |
| 小孙愿景 | 「保证 A、B 之间独立，不聊起来」（Round 1 场景 1） |

**独立撞点**：三方对「不聊起来」完全一致 —— 协议层（范德彪）、前端层（桂芬）、愿景层（小孙）独立收敛到同一条 invariant。

**收敛提案**：
- 协议侧：sibling 之间**默认不可见**；要交互必须通过 parent 或建新 child call，**convener 在 call 创建时显式指定**，不靠嵌套自动转移
- 前端侧：独立卡片渲染，B 的 context 里不含 C 的消息
- 新增不变量 **I9 · Branch Isolation**

---

### Q5 · `discussions` 表 vs `a2a_calls` 扩字段

| 方 | 立场 |
|---|---|
| 范德彪 | **不拆 discussions 表**，先把真相源压进 `a2a_calls`：补 `issuer_id, convener_id, parent_call_id, root_call_id, join_set_id, on_behalf_of, status`。**convener 显式决定**，不靠嵌套转移（小孙的 "A 为自己问 B" vs "A 代表 caller 拉 B" 是两种完全不同语义，必须两个字段区分） |
| 桂芬 | 未正面讨论表结构，但 Envelope 里主张 `parentCallId / rootRequester` 焊死在协议层 |

**收敛提案**：采纳。`a2a_calls` 表一次扩到位（上列 7 字段 + 既有 callId/status/deadline/created_at/updated_at）。`discussions` 先挂着，后续如果发现需要独立收敛语义再拆。

**对现行 F026 spec 的影响**：
- P1 Phase 的 `a2a_calls 表 + drizzle migration` 任务扩到上述字段全集
- I4 Registry 持久化对应扩字段

---

### Q6 · worklist 续推在 spec 里的定位

| 方 | 立场 |
|---|---|
| 范德彪 | 如果 Q1 走 (b)，**P2 worklist 续推从协议中心降级为执行细节**，不再决定产品语义 |

**收敛提案**：采纳。**Phase 2 保留**（R-184 双消息根治仍然靠同 routeSerial 续推而不是新 invocation），但在 spec 里的章节层级下沉到「执行器实现」，不再是不变量之一。

**对现行 F026 spec 的影响**：
- Design Decisions 表第 1 行原结论 「A 全抄」保留，但备注「抄的是执行机制，不是协议模型」
- I2 拆分：I2-a 「同一 turn 不产生两行 DB message」留作不变量；I2-b 「worklist 续推」降级为实现手段
- P2 Phase 标题从「Worklist 续推」改「Return-path → Worklist 执行器改造（同 turn 单行 message）」

---

### Q12 · 收敛权是否可以「转让」（桂芬 R2 新增分歧点）

| 方 | 立场 |
|---|---|
| 桂芬 | **(A) 严格分级**：C→B→A→小孙，不穿透（推荐） |
| 桂芬提出的对立项 | (B) 穿透模式：C 可直达小孙，标记 A→B→C 链 |
| 范德彪 | Q4 立场即「tree 干净 / 收敛责任不漂 / sibling 不开侧门」≈ **(A) 严格分级** |
| 小孙愿景 | 「由提出方收敛（无论中间过多少轮）」= (A) |

**独立撞点**：桂芬 Q12 (A) 严格分级 ≈ 范德彪 Q4 tree 干净 ≈ 小孙愿景「由提出方收敛」—— 三方独立收敛到同一条。

**收敛提案**：采纳 (A) 严格分级 **作为默认**；但要留一个**显式豁免口**：

- 默认：C 的结果沿 convener_id 回到 B，B 收敛回 A，A 收敛回小孙
- 豁免：A 在 call 创建时可以显式设置 `convener=caller`（「A 代表 caller 拉 B」场景），此时 C 的回执直达 caller，A 仅作 issuer 不做收敛
- **豁免必须显式**，不靠嵌套自动推导（= Q5 结论）

**对现行 F026 spec 的影响**：新增不变量 **I10 · Convener Explicit**

---

## 三、强信号 · 独立撞点汇总（高置信度产出）

| 议题 | 范德彪（协议） | 桂芬（UX） | 小孙（愿景） |
|---|---|---|---|
| 行首 @ vs 文中 @ | Q2 hard-positive 行首 @ | S3 意图嗅探 行首派发 | agent 不遵从 prompt（场景 3） |
| 不聊起来 / 独立卡片 | Q4 sibling 不直聊 | Visual Silo 并列卡片 | 「A、B 之间独立，不聊起来」 |
| 收敛权不漂 | Q5 convener 显式 / Q4 tree 干净 | Q12 (A) 严格分级 | 「由提出方收敛」 |

**这三条在三视角下都独立撞到 = 可以直接锁死为 F026 硬不变量**。

---

## 四、桂芬独有前端原语（全部纳入 F026 前端层）

| 原语 | 挂在哪 | 备注 |
|---|---|---|
| 溯源胶囊（`A 正在征询 / B (为 A) 正在征询`） | I5 Observable State · 前端栏 | 桂芬 R1 |
| 意图嗅探（⚡️ vs 普通 link） | I1' 层 2 的 UX 映射 | 桂芬 R1 + 范德彪 Q2 撞点 |
| 超时墓碑（`@B 响应超时，A 请继续`） | I5 · 前端栏 + I6 lifecycle 失败 UX | 桂芬 R1 |
| 折叠群组 · A2A 子消息默认半透明/缩进 | I5 · 前端栏 | 桂芬 R1（解决 S7 结构化信封展示半） |
| 并列卡片 · 独立 Visual Silo | I9 Branch Isolation · 前端实现 | 桂芬 R2（Q4 UX 映射） |
| 状态 Pulse · `👂 正在听取 @B @C` | I5 · 前端栏 | 桂芬 R2 |
| Envelope `displayMode: inline/nested/background` | I8 · task.render 子层 | 桂芬 R2 |

---

## 五、对现行 F026 spec 的「改」清单（建议改动 · 待小孙拍板）

### 5.1 不变量清单（I1-I6 → I1'-I10）

| 原编号 | 原文 | 改动 |
|---|---|---|
| I1 | AgentRef + Markdown-AST mention | 升级 **I1'**：三层 fail-closed（hard-neg / hard-pos / gray-zone classifier） |
| I2 | Worklist 续推 + Call Lifecycle | 拆：**I2-a**「同 turn 单行 message」保留；**I2-b**「worklist 续推」降级为 Phase 2 执行手段 |
| I3 | Broadcaster 后端强隔离 | **不变** |
| I4 | Registry 持久化 + CAS | 扩：包含 `a2a_calls` 全字段（Q5 列表） |
| I5 | Observable State | 扩出 **前端栏**：溯源胶囊 / 墓碑 / 折叠群组 / Pulse |
| I6 | 身份贯穿 | **不变**（本来就是 callId 全链路） |
| — | — | **新增 I7 · Call Tree 贯穿**（call_id / parent / root / issuer / convener 全链路） |
| — | — | **新增 I8 · Envelope 双层 + 版本化** |
| — | — | **新增 I9 · Branch Isolation**（sibling 默认不可见） |
| — | — | **新增 I10 · Convener Explicit**（不靠嵌套自动转移） |
| — | — | **新增 I11 · A2A 对 agent 层透明**（agent 不加载任何 skill、不感知任何协议字段；Envelope 由消息 router 自动打包；CLAUDE.md / GEMINI.md / AGENTS.md 不承载任何 A2A 协议内容）。具体 violation 示例与 β/γ 双路径见 **ADR-004 §6.3** |

### 5.2 Design Decisions 表（最大改动）

| 决策 | 原结论 | 改动 |
|---|---|---|
| 抄 clowder worklist 续推 | A 全抄 | **结论保留，定位调整**：抄的是执行机制（同 routeSerial 续推 = R-184 解药）；**协议真相源改走 Call Tree** |
| 统一 A2ASession 对象 vs 六条不变量驱动 | B 不变量 | **扩为十条不变量**（I1'-I10） |
| Burst / Tombstone / rollingSummary 字段位置 | 未明确 | **定案**：归 `task.context`，不是路由头 |
| A2A sibling 交互模型 | 未明确 | **定案**：默认不可见；显式建新 child call |
| 收敛权转让 | 未明确 | **定案**：默认严格分级；显式 `convener` 豁免 |

### 5.3 Phase 拆分

| Phase | 原内容 | 改动 |
|---|---|---|
| P0 | composer isBusy + Broadcaster 过滤 + Replay Harness | **不变** |
| P1 | `a2a_calls` 表 + I1 + I6 + callback token + CAS + 双轨 flag | 扩：`a2a_calls` 字段按 Q5 全集；**I1 升 I1'**；新增 Call Tree registry 骨架 |
| P2 | 废 F003 return-path + worklist 续推 + system prompt 硬编码 | 改标题：**Return-path → Worklist 执行器改造（同 turn 单行 message）** |
| P3 | Burst + Tombstone + protectSemanticChains | **不变**（挂 `task.context`） |
| P4 | Registry 持久化 | **不变**，作用域扩到 Call Tree |
| P5 | `/debug/a2a` + @ pill + Coordinator + 结论卡片 | 扩：溯源胶囊 / 并列卡片 / Pulse / 折叠群组（I5 前端栏全量） |

---

## 六、三件套（collaborative-thinking Mode C · 收敛产物）

**权限说明**：三件套**最终落盘由小孙 Design Gate 放行后**在 F026-p0 worktree 下落（不在 dev 落）。本节是内容 draft。

### 6.1 ADR-002 草案 · A2A 协议真相源改写

> **注**：之前桂芬 R2 中提到的「ADR-002-a2a-worklist-continuation」属于越位产物（Round 2 讨论未定案她直接落盘到 dev，已回退）。**此处 ADR-002 重新定义，内容不同**。

- **Title**：A2A 协议真相源从「worklist/return-path」升级为「Call Tree + Explicit Convener」
- **Status**：Proposed（等 Design Gate）
- **Context**：Round 1 愿景确认「逐级收敛 + 独立 + 结构化」；Round 2 范德彪代码证据表明现行 `a2a-chain.ts / return-path.ts / parallel-group.ts / settlement-detector.ts` 的最小单位是 sessionGroup 不是 call tree
- **Decision**：协议真相源 = Call Tree（call_id / parent / root / issuer / convener / on_behalf_of）+ Pending Set + Join。worklist 降级为执行器细节
- **Consequences**：
  - (+) R-184 双消息仍然可由「同 turn 单行 message」不变量保证
  - (+) 「A 代表 caller 拉 B」等模糊场景有 issuer/convener 两字段明确区分
  - (−) `a2a_calls` 表字段增多，迁移成本
  - (−) 旧 F003 return-path 需并行 2 周 double-write 再切

### 6.2 ADR-003 草案 · A2A @ 识别三层 fail-closed

- **Title**：A2A @ 识别策略：hard-negative / hard-positive / gray-zone 三层 fail-closed
- **Status**：Proposed
- **Decision**：见 §Q2 收敛提案表
- **Consequences**：
  - (+) code block / blockquote 里的 @ 不再误派（Round 2 自带实证）
  - (+) 「@范德彪 是安全大师」这类介绍句不误派
  - (−) 灰区分类器需要训练样本；一期可以用纯规则骨架 + 日志采集
- **Rollout**：Phase 1 落 hard-neg/hard-pos 纯规则骨架；灰区分类器留 Phase 5 或单独 F

#### 补充 · on-behalf 语义反推（2026-04-23 小孙对话新增）

除三层 @ 识别外，mention-router 还负责**从自然语言信号反推 `on_behalf_of` 和 `convener_id` 豁免**。这是让「A 代表小孙拉 B」场景可自动识别的关键 —— agent 不填字段，router 听话。

**触发词典（初版 · 中文）**：

| 自然语言信号 | 反推字段 | 示例 |
|---|---|---|
| 「**帮**/**替**/**代**/**为** X + @B」 | `on_behalf_of = X`、`convener_id = X`（豁免严格分级） | A 说「@B **帮**小孙 review 一下」→ B 的回执直达小孙，不经 A 收敛 |
| 「@B + **（**仅 X 参考**）**」 | `on_behalf_of = X`（观众视角，不转收敛权） | A 叫 B 但结果给 X 看，A 仍负责收敛 |
| 无上述信号 | `on_behalf_of = null`、`convener_id = parent.issuer`（默认严格分级） | 普通 @B，结果沿 parent 回流 |

**实现约束**：
- 词典用**规则优先**（LLM-assisted 可选 fallback，但 Phase 1 纯规则够用）
- **模糊/冲突时 fail-closed**：默认不豁免、走严格分级（保守不出错）
- 词典配置**可外挂**（不硬编码在 `mention-router.ts`），后续加词不用改代码

**与 ADR-002 的关系**：这是 `convener_id` 字段的**来源之一**（另一来源是 API caller 显式传参）。两条路同等合法。

**对 §Q5 `a2a_calls` 表的影响**：`convener_id` 字段的写入时机 = mention-router 解析完成后、envelope-builder 封装前。

### 6.3 ADR-004 草案 · A2A 对 agent 层透明（小孙 2026-04-23 拍板新增）

- **Title**：A2A 对 agent 层透明 —— agent prompt 不承载任何协议内容
- **Status**：Proposed
- **Context**：Round 2 收敛报告第一版里 §6.4 把「Envelope 格式 / A2A 使用规则」挂到 `CLAUDE.md / GEMINI.md` 落地，被小孙识别为方向错误：A2A 是 agent 之间的**正常对话**，不是需要 agent 学习协议字段的特殊流程。桂芬 11:43 提议「去更新 CLAUDE.md / GEMINI.md 的 UX 规范」属级联事故下的衍生动作项，不应被当作严肃建议收。
- **Decision**：
  1. **A2A 对 agent 层完全透明**：agent 收发消息就是收发消息，不加载 skill、不感知 Envelope 字段、不学习 @ 识别规则
  2. **Envelope 由消息 router / API 中间件自动打包**：`parent_call_id` 从当前会话 context 推、`on_behalf_of` 从 call stack 推、`display_mode` 由触发方式定 —— agent 一个字段都不填
  3. **前端渲染**（缩进 / 并列卡片 / 淡紫色底 / 溯源胶囊 / 折叠群组）由前端根据 Envelope 字段自动完成，不靠 agent 感知
  4. **@ 识别**（hard-neg / hard-pos / gray-zone）在 mention-router 代码层强制，不靠 agent 自觉
  5. **`CLAUDE.md` / `GEMINI.md` / `AGENTS.md` / `packages/api/src/runtime/agent-prompts.ts` 禁止承载任何 A2A 协议内容**：协议 schema、字段定义、UX 规范、@ 识别规则一律不进 agent prompt
  6. **协议 schema 归**：`packages/*/a2a-envelope.ts` TypeScript 类型 + `F026-a2a-reliability-layer.md` spec
  7. **`cross-role-handoff` skill 是小孙或 agent 显式触发的正式交接通道**，与 A2A 默认路径**不交叉**，两条路独立
- **Consequences**：
  - (+) agent prompt 永久保持精简（身份 + Iron Laws + Skill 路由 + 流程链），不随协议演进膨胀
  - (+) 协议靠机器强制而非 agent 自觉，fail-closed 强度更高
  - (+) Envelope 字段后续演进不影响 agent prompt（不需要重新训练/微调 agent 对协议的理解）
  - (+) 拟人化自然达成：agent 就是在说话，复杂度住在下层
  - (−) mention-router / message router 的代码复杂度上升（但本来就该在那承担）
  - (−) 桂芬 R2 那条「更新 CLAUDE.md UX 规范」动作项作废，需在 room 里明说落点改为 spec + 前端代码（非否定她的字段设计）
- **Violation 示例（作为未来判例）**：
  - ❌ CLAUDE.md 新增「A2A 调用时请携带 parent_call_id」
  - ❌ agent-prompts.ts 注入「请用 @ 派发任务，行首 @ 是指令，文中 @ 是提及」
  - ❌ Skill 里写「A2A 消息必须经过 cross-role-handoff skill」
  - ✅ mention-router 拒收不合规 @ 并返回 400
  - ✅ 前端组件根据 `displayMode` 自动切渲染模式

---

#### ADR-004 附录 A · β / γ 双路径（2026-04-23 小孙对话定案）

agent 层只存在两条入口，分别承担不同的 Envelope `task` 层结构化强度：

| 路径 | 入口 | `task` 层填充 | 占比 | 小孙定性 |
|---|---|---|---|---|
| **β · 日常 A2A 对话** | agent 在 composer / room 直接说话 | `task = "conversation"` + `input.source_message = 原文整段` + `expected_output/constraints = null` | ~95% | **原文直达，拟人化默认** |
| **γ · 正式交接** | agent 或小孙**显式**调 `cross-role-handoff` skill | `task = "review/implement/decide/..."` + `input/expected_output/constraints` 按 skill 模板 | ~5% | 结构化契约，skill 模板 = 填表 |

**关键约束**：
- **β 不抽取 task/input/expected/constraints 四字段**。不做 NLP 解析、不猜、不结构化 —— 保留原文即是最佳行为。
- **γ 的结构化来自 skill 模板本身**，不来自 agent 自觉。agent 填 skill 参数 = 填 Envelope.task，agent 不知道自己在填 Envelope。
- **两条路不交叉**：β 入口不升格 γ、γ 入口不降级 β。
- **两条路共享 protocol 层（call_id / parent / issuer / convener / on_behalf_of / ...）自动填充**，差异仅在 `task` 子树。

**为什么这样分**：
- 全走 β（都原文）→ 丢失结构化红利，B 还是靠猜
- 全走 γ（都结构化）→ 违反 I11 agent 透明，CLAUDE.md 必然膨胀
- β/γ 分流 = 把结构化成本押给「正式交接」这个**天然就该慢下来**的场景

---

#### ADR-004 附录 B · Envelope 填充责任矩阵（2026-04-23 小孙对话定案）

字段 → 填充模块 → 触发时机一一对应。**agent 列永远是 ❌**。

| Envelope 字段 | 填充模块（代码） | 触发时机 | agent 参与？ |
|---|---|---|---|
| `call_id` | `envelope-builder.ts` | 消息出站，`uuid()` | ❌ |
| `parent_call_id` | `call-registry.ts` | 取发送者当前活跃 call 栈顶 | ❌ |
| `root_call_id` | `call-registry.ts` | 沿 parent 追到根 | ❌ |
| `issuer_id` | 消息出站钩子 | = 发送者 agent ID | ❌ |
| `convener_id` | `mention-router.ts`（语义反推） + API 显式传参兜底 | 默认 `parent.issuer`；有「帮/代/替」触发词则豁免 | ❌（agent 写自然语言，router 推断） |
| `on_behalf_of` | `mention-router.ts` | 同上触发词词典 | ❌ |
| `reply_to` | 消息出站钩子 | = issuer 的回执入口 | ❌ |
| `deadline` | 配置 + `envelope-builder.ts` | 默认值或 call type 规则 | ❌ |
| `render.displayMode` | `envelope-builder.ts` 规则 | 有 parent=`nested`；无 parent=`inline`；slash command=`background` | ❌ |
| `task`（β 路径） | `envelope-builder.ts` | 常量 `"conversation"` | ❌ |
| `task`（γ 路径） | `cross-role-handoff` skill 模板 | skill 参数表 | ✅（通过填 skill 参数间接提供） |
| `input.source_message`（β） | `envelope-builder.ts` | agent 的原文整段 | ❌ |
| `input/expected_output/constraints`（γ） | skill 模板 | skill 参数 | ✅（同上） |
| `context.burst` | 消息总线滑动窗口服务 | 出站时取最新窗口快照 | ❌ |
| `context.tombstone` | 超时检测器 | deadline 到期自动标 | ❌ |
| `context.rolling_summary` | 后台摘要服务 | 定期生成 / 触发式 | ❌ |

**模块归属 Phase**：

| 模块 | 归 Phase |
|---|---|
| `call-registry.ts` / `envelope-builder.ts` / `mention-router.ts`（三层 @ + on-behalf 反推） | **Phase 1** |
| 超时检测器 + tombstone 填充 | Phase 3 |
| rolling_summary 后台服务 | Phase 3 |
| 前端 `displayMode` 渲染（溯源胶囊/嵌套/并列/淡紫色） | Phase 5 |
| `cross-role-handoff` skill 模板微调（γ 路径入口） | Phase 1 收尾同步改 skill |

---

#### ADR-004 附录 C · 完整数据流（agent 嘴边 → 对方眼前）

```
┌───────────────────────────────────────────────────────┐
│ Agent A 在 composer 里写:                            │
│   "@B 帮小孙看下这个 PR"                              │   ← agent 层唯一动作
└───────────────────────────────────────────────────────┘
                     ↓ 点发送
┌───────────────────────────────────────────────────────┐
│ mention-router.ts                                     │
│  · hard-pos 检测: 行首 "@B" + 动作词 "看" → 派发     │
│  · 语义反推: "帮小孙" → on_behalf_of=小孙,          │
│                           convener_id=小孙（豁免）    │
└───────────────────────────────────────────────────────┘
                     ↓
┌───────────────────────────────────────────────────────┐
│ envelope-builder.ts                                   │
│  protocol.call_id        = uuid()                     │
│  protocol.parent_call_id = A 当前活跃 call            │
│  protocol.root_call_id   = 向上追根                   │
│  protocol.issuer_id      = A                          │
│  protocol.convener_id    = 小孙（mention-router 给）  │
│  protocol.on_behalf_of   = 小孙（同上）               │
│  protocol.reply_to       = A 的回执入口               │
│  protocol.deadline       = 默认 30min                 │
│  task.task               = "conversation"（β 路径）   │
│  task.input.source_message = "@B 帮小孙看下这个 PR"  │
│  task.render.displayMode = "nested"（有 parent）      │
│  task.context.burst      = 从总线取                   │
│  task.context.rolling_summary = 摘要服务最新          │
└───────────────────────────────────────────────────────┘
                     ↓
┌───────────────────────────────────────────────────────┐
│ message-router                                        │
│  · 写 a2a_calls 表（call_id / 所有 protocol 字段）   │
│  · 按 call_id 投递到 B 的 inbox                       │
└───────────────────────────────────────────────────────┘
                     ↓
┌───────────────────────────────────────────────────────┐
│ 前端渲染（B 侧）                                      │
│  · displayMode=nested → 缩进卡片（40px）             │
│  · on_behalf_of=小孙 → 消息头"B（为小孙）"           │
│  · 溯源胶囊: "A 正在征询 / B (为小孙) 正在征询"      │
│  · 展示 input.source_message 原文                    │
└───────────────────────────────────────────────────────┘
                     ↓
┌───────────────────────────────────────────────────────┐
│ Agent B 看到的内容（Envelope 完全不可见）:            │
│   "A 说: @B 帮小孙看下这个 PR"                        │
└───────────────────────────────────────────────────────┘
                     ↓
                 B 用自然语言回复
                     ↓
                 相同流程反向
                     ↓
┌───────────────────────────────────────────────────────┐
│ 收敛路径: B 的回执 → convener_id=小孙（不是 A）      │
│ 理由: "帮" 字触发豁免，收敛权不在 A                  │
└───────────────────────────────────────────────────────┘
```

**三点本质**：

1. **agent 只写自然语言 + 读自然语言**。它不看 Envelope、不填 Envelope、不知道 Envelope 存在。
2. **"帮小孙"三个字**就是 on-behalf 语义反推的输入 —— 语言即协议，agent 天然会说。
3. **收敛路径分歧**完全由 router 层根据 `convener_id` 决策，agent 不需要记"收敛权是否可转让"这种规则。

- **对 §6.5 SOP 建议的覆盖**：ADR-004 生效后，原 §6.4「CLAUDE.md / GEMINI.md 补 A2A 使用规则」**直接作废**，见本节 §6.5 改写。

### 6.4 Lessons Learned 草案

**LL-028 · mention-router 必须过 Markdown AST（代码块 / 引用块 / 装饰标签）**
- 原现象：2026-04-23 Round 2 讨论期间，`A2A @黄仁勋 老师的总结` 这类出现在 code block 内的 @ 被旧 mention-router 纯正则识别 → 误派给桂芬 → 桂芬扩展讨论 → **讨论本身产生了它要修复的 bug**
- 归因：I1 原文已经识别此漏，但 P1 尚未实施；Round 2 不是新发现，而是「自带实证」
- 作用：Phase 1 的 I1' 回归用例直接收这次事故的 fixture

**LL-029 · Convener 未拍板前禁止自开 ADR / 禁止直接往 dev 落盘（越位防线）**
- 原现象：2026-04-23 12:05 桂芬在 Round 2 讨论**未收敛**状态下自开 `ADR-002-a2a-worklist-continuation.md` + `LL-026/LL-027` + `GEMINI.md` 改动 + 直接 commit 到本地 dev（`cf11ff5`），跳过 Design Gate
- 归因：S2 收敛权愿景未以硬规则写入 skill 层；feat-lifecycle 的「架构级 → agents 讨论 → 小孙拍板」在 skill 里是软约束
- 作用：self-evolution skill 增补「discussion 阶段 agent 仅发言，不得直接落盘产物」；merge-gate 增补「convener draft 必须在 worktree 不在 dev」
- **注**：LL-029 不属于 F026 feature 范畴，本条记录在此仅为完整性；如采纳应由 self-evolution skill 独立走

### 6.5 SOP 更新 · 已被 ADR-004 覆盖

**原第一版建议**（已作废）：

> ~~`CLAUDE.md` / `GEMINI.md` 补 A2A 使用规则：何时用 @（行首 + 动作对象） / 何时仅提及（文中描述性）/ 收敛责任归属 / Envelope 格式~~

**作废理由**：ADR-004（§6.3）确立 A2A 对 agent 层透明。agent prompt 禁止承载协议内容。

**替代路径**：

| 原打算写进 CLAUDE.md 的内容 | 改到哪 |
|---|---|
| @ 识别（行首 vs 文中） | `packages/*/mention-router.ts` 代码强制 + `F026-spec.md` 文档化 |
| 收敛责任归属 | `a2a_calls` 表 `convener_id` 字段 + router 路由逻辑 |
| Envelope 格式 | `packages/*/a2a-envelope.ts` TypeScript 类型 + `F026-spec.md` |
| 溯源胶囊 / 并列卡片 / 淡紫色 / 折叠群组 | `F026-spec.md` UX 规范 + 前端组件代码 |

**agent 层唯一变化**：零 —— CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts **一个字都不加**。

---

## 七、未决项 · 等小孙拍板

| # | 决策点 | 选项 |
|---|---|---|
| D1 | Q1-Q6 + Q12 收敛提案**整体**是否接受？ | **(A)** 整体接受（直接按 §五改 spec） **(B)** 某条要退回重议（请点名） **(C)** 我改错方向，全推翻 |
| D2 | 十不变量（I1'-I10）编号体系 | **(A)** 采纳 **(B)** 保留原 I1-I6 编号，新增条挂 I7-I10 **(C)** 让我重拟 |
| D3 | Phase 拆分改动 | **(A)** 按 §5.3 改 **(B)** 不改 Phase，只改 spec 内容 **(C)** 其他 |
| D4 | ADR-002（协议真相源改写）+ ADR-003（@ 三层识别）+ **ADR-004（A2A 对 agent 层透明，2026-04-23 新增）** | **(A)** 放行落 worktree docs/adrs/ 等 Phase 1 开始前 merge **(B)** 先挂 draft 等 Phase 1 实施时一起落 **(C)** 不要 ADR 直接写 spec |
| D5 | LL-028 / LL-029 | **(A)** 两条都落 `docs/lessons/lessons-learned.md`（LL-029 由 self-evolution skill 独走） **(B)** 只落 LL-028；LL-029 合并到 shared-rules §17 或新 §18 |
| D6 | 桂芬 R1 open question：A2A 中间过程**淡紫色背景** UX | **(A)** 同意 **(B)** 换色 **(C)** 不加底色（子消息靠缩进 + 半透明区分即可） |

---

## 八、执行路径（拍板后）

```
D1-D6 全拍 →
  writing-plans 拆 Phase 1 详细 AC（call tree registry 骨架 / a2a_calls 扩字段 / I1' 三层识别 / callback token） →
    tdd 开 Phase 1（仍在 F026-p0 worktree） →
      P1 完成 → quality-gate → acceptance-guardian → requesting-review → receiving-review → merge-gate
```

本文件本身在收敛通过后：
- 重命名为 `docs/discussions/2026-04-23-F026-design-round-2.md`（对齐现有命名）
- 或按决议转化为 ADR-002/003 + spec 改动 PR

---

## 九、本收敛报告本身的产出承诺（convener）

- **本文件在 F026-p0 worktree 写**，不发 room（减少 Round 2 讨论期间再多一轮派发风暴）
- **待小孙 D1-D6 拍板后**，我才动 `docs/features/F026-a2a-reliability-layer.md` / ADR / lessons-learned
- **如果 D1 是 (B) 或 (C)**，我回改后再来一轮，不强推本版
- 本文件的任何结论在小孙拍板前**不构成对 Phase 1 实施的约束**

— 黄仁勋 [Opus-47 🐾] · 2026-04-23
