---
id: ADR-004
title: A2A 对 agent 层透明 — agent prompt 禁止承载任何 A2A 协议内容
status: Amended
feature: F026
date: 2026-04-23
approved_by: 小孙（Design Gate D4 · 2026-04-23 PM）
amended: 2026-05-08
amended_by: 黄仁勋（小孙 2026-05-08 拍板"今日闭环 · 改 ADR 不改实现"）
implementation_status: amended_partial · "agent 不填 Envelope 协议字段"成立；"agent 不感知任何协议内容"被「方案 X · `[Call: @名 描述]` 元指令语法」打破——agent 必须学一条**消息内语法**（不是 Envelope 字段）来表达派发意图
supersedes: null
related: ADR-002, ADR-003
---

# ADR-004 · A2A 对 agent 层透明

## Context

Round 2 讨论（2026-04-23 PM），我（convener 黄仁勋）在 Round 2 收敛报告第一版里把「Envelope 格式 / A2A 使用规则」挂到 `CLAUDE.md / GEMINI.md` 落地（§6.4 SOP 建议）；桂芬在 room 11:43 级联事故下的动作项里也说「我就去更新 CLAUDE.md / GEMINI.md 的 UX 规范」。

小孙当天 PM 两轮对话连续识别出方向错误：

> 「A2A 是正常对话，不需要加载任何 skill」
> 「如果 A2A 真正拟人，应该是原文直达，而不是每次都结构化给别人」
> 「我怕增加负担，在 .md 文件中添加太多内容」

核心诊断：

1. **CLAUDE.md 每行 × 每 agent × 每轮对话 = 永久成本**。当前文件极度精简（Iron Laws + Skill 路由 + 流程链，< 20 行）。Envelope schema 塞进去会膨胀到协议百科，每次对话每个 agent 都要读一遍协议字段
2. **协议应该靠机器强制，不是 agent 自觉**。如果要求 agent 在消息里填 `parent_call_id`，那就是把协议层责任推给了不稳定的自然语言生成
3. **拟人化的本质**：agent 说话就是说话，协议字段对它不可见
4. 桂芬 11:43 那条的 UX 字段设计（parentCallId / displayMode / onBehalfOf）**本身是好的**，但**落点错了**——应落到代码 + spec，不落到 agent prompt

## Implementation Note · 2026-05-08 追认（小孙："今日闭环 · 改 ADR 不改实现"）

> 这一节是**追认**，不是新决策。F026 在落地过程中（2026-04-23 ADR-003 → 2026-04-27 P3.1 retry guard）发现"完全靠机器猜 agent 派发意图"无法在 LLM 自然语言生成的不稳定性下守住边界（R-053 / R-054 / 房间级联误派）。Layer 2 hard-positive 被替换为 **`[Call: @名 描述]` 显式调用标签**（详见 ADR-003 Implementation Note），这条**元指令语法必须教给 agent**——`agent-prompts.ts` line 36 + 68-88 + `multi-agent-skills/refs/shared-rules.md` line 64-68 已含 `[Call:]` 教育内容。
>
> 今日（2026-05-08）小孙拍板"今天闭环 · 改 ADR 不改实现，以后想改在新 feature 起"——故而把现实状态写进 ADR 让文档与代码一致，不重做架构。

### 现行原则（amended · 2026-05-08）

**A2A 对 agent 层 *协议字段* 透明，但 *派发意图* 由 agent 显式声明**。Agent 做三件事：

1. **写自然语言消息**（普通文本随便写）
2. **派发意图用 `[Call: @X 描述]` 显式声明**（这是消息内语法，不是 Envelope 字段）
3. **读自然语言消息**（渲染后的气泡，pill 替换 `[Call:]` 字面量）

### 仍然生效（不变）

- ✅ Agent **永不**感知 `call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of / reply_to / deadline / join_set_id / envelope_version` 任何 Envelope 协议字段——这些**全部**由 `call-registry.ts` + `mention-router.ts` + `envelope-builder.ts` 三件套在消息出站时自动填，**附录 B 责任矩阵 agent 列仍永远 ❌**
- ✅ Envelope 由消息 router / API 中间件自动打包，agent 一字未填
- ✅ 前端渲染（缩进 / 并列卡片 / 淡紫色 / 溯源胶囊）由前端根据 Envelope 字段自动完成
- ✅ Layer 1 hard-negative + Layer 3 gray-zone + on-behalf 反推 + 反循环去重 全部仍在 router 层（ADR-003 Implementation Note）
- ✅ β/γ 双路径仍生效：β = 日常 A2A `task=conversation` + 原文整段；γ = `cross-role-handoff` skill
- ✅ `cross-role-handoff` skill 仍是显式触发的正式交接通道，与 A2A 默认路径不交叉

### 被打破（amended）

- ⚠️ **"agent 永不学 @ 识别规则"被打破**：agent 现在必须学**一条**消息内语法 `[Call: @X 描述]`——参见 `agent-prompts.ts:68-88` + `shared-rules.md:64-68`
- ⚠️ ADR-004 §子决议 4 "`CLAUDE.md` / `GEMINI.md` / `AGENTS.md` / `agent-prompts.ts` 禁止承载任何 A2A 协议内容"原则**部分让步**：
  - **`agent-prompts.ts` + `shared-rules.md`** 是 [Call:] 教育的**单一真相源**，可以承载这条消息内语法
  - **`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`** 三家入口 .md 仍保持零字节增长（B022 commit `aa55f82` 已砍三家 .md 完成；`scripts/ci/check-adr-004-content.ts` + `check-adr-004-diff.sh` CI guard 仍生效，守这三个文件不再膨胀）
  - 边界：教育内容**只在 agent-prompts.ts + shared-rules.md** 写一处；不再多源冗余（B022 教训）

### Violation 示例（amended）

- ❌ `CLAUDE.md` 新增任何 A2A / Envelope / `[Call:]` 内容（diff guard 卡住）
- ❌ `GEMINI.md` / `AGENTS.md` 同上
- ❌ `agent-prompts.ts` 新增 Envelope 协议字段（`call_id` / `parent_call_id` / `convener_id` / ...）的填写规则
- ❌ `agent-prompts.ts` 教 agent 自己计算 `parent_call_id` 或在消息里写 protocol 字段
- ✅ `agent-prompts.ts` 教 agent `[Call: @X 描述]` 元指令语法（这是消息内语法，不是 Envelope 字段）
- ✅ `mention-router.ts` 拒收嵌套 / 裸 @ 派发并 retry 3 次
- ✅ `envelope-builder.ts` 从 call-registry 自动取 protocol 字段

### 为什么这么妥协（务实理由）

1. **LLM 自然语言生成的不稳定性**让"Layer 2 hard-positive 词典"永远在追补丁（R-053 / R-054 翻车）。让 agent 显式声明意图代价 << 维护词典代价
2. **"agent 永不感知协议"是理想，"agent 学一条最简元指令"是实操**。`[Call:]` 是消息内 5 字符的语法标记，不是 Envelope 字段；agent 仍不感知 call_id / parent / convener 等任何**真协议**字段
3. F026 拖了两周（380 commits），今日必须闭环。新方向（如"双契约"）以后**起新 feature** 改

---

## Decision（原始 · 2026-04-23 · 历史保留）

### 核心原则

**A2A 对 agent 层完全透明**。Agent 只做两件事：

1. **写自然语言消息**（可能含行首 `@B` 指令）
2. **读自然语言消息**（渲染后的气泡）

Agent **永不**：

- 加载任何 skill 作为 A2A 默认路径
- 感知 Envelope 字段
- 学习 @ 识别规则
- 知道 call tree / convener / on_behalf_of 的存在

### 六条子决议

1. **Envelope 由消息 router / API 中间件自动打包**。`envelope-builder.ts` 在消息出站时从 call-registry + 发送者 context + mention-router 输出三处取字段，一次性封装
2. **前端渲染**（缩进 / 并列卡片 / 淡紫色 / 溯源胶囊 / 折叠群组）由前端根据 Envelope 字段自动完成，不靠 agent 感知
3. **@ 识别**（hard-neg / hard-pos / gray-zone + on-behalf 反推）在 `mention-router.ts` 代码层强制（ADR-003），不靠 agent 自觉
4. **`CLAUDE.md` / `GEMINI.md` / `AGENTS.md` / `packages/api/src/runtime/agent-prompts.ts` 禁止承载任何 A2A 协议内容**（硬约束）
5. **协议 schema 归**：TypeScript 类型定义在 `packages/*/a2a-envelope.ts`；文档在 `F026-a2a-reliability-layer.md` spec
6. **`cross-role-handoff` skill 是显式触发的正式交接通道**，与 A2A 默认路径**不交叉**

### Violation 示例（作为未来判例）

- ❌ `CLAUDE.md` 新增「A2A 调用时请携带 parent_call_id」
- ❌ `agent-prompts.ts` 注入「请用 @ 派发任务，行首 @ 是指令，文中 @ 是提及」
- ❌ `CLAUDE.md` 新增「Envelope.displayMode 可选 inline/nested/background」
- ❌ Skill 文档里写「A2A 消息必须经过 cross-role-handoff skill」
- ✅ `mention-router.ts` 拒收不合规 @ 并返回 400
- ✅ `envelope-builder.ts` 从 call stack 推断 parent_call_id
- ✅ 前端组件根据 `displayMode` 自动切渲染模式

---

## 附录 A · β / γ 双路径

Agent 层只存在两条入口，分别承担不同的 Envelope `task` 层结构化强度：

| 路径 | 入口 | `task` 层填充 | 占比 | 定性 |
|---|---|---|---|---|
| **β · 日常 A2A 对话** | agent 在 composer / room 直接说话 | `task = "conversation"` + `input.source_message = 原文整段` + `expected_output/constraints = null` | ~95% | **原文直达，拟人化默认** |
| **γ · 正式交接** | agent 或小孙**显式**调 `cross-role-handoff` skill | `task = "review/implement/decide/..."` + `input/expected_output/constraints` 按 skill 模板 | ~5% | 结构化契约，skill 模板 = 填表 |

### 关键约束

- **β 不抽取 task/input/expected/constraints 四字段**。不做 NLP 解析、不猜、不结构化 —— 保留原文即是最佳行为。
- **γ 的结构化来自 skill 模板本身**，不来自 agent 自觉。agent 填 skill 参数 = 填 Envelope.task，agent 不知道自己在填 Envelope。
- **两条路不交叉**：β 入口不升格 γ、γ 入口不降级 β
- **两条路共享 protocol 层**（call_id / parent / issuer / convener / on_behalf_of / ...）自动填充，差异仅在 `task` 子树

### 为什么这样分

- 全走 β（都原文）→ 丢失结构化红利，B 还是靠猜
- 全走 γ（都结构化）→ 违反 I11 agent 透明，CLAUDE.md 必然膨胀
- β/γ 分流 = 把结构化成本押给「正式交接」这个**天然就该慢下来**的场景

---

## 附录 B · Envelope 填充责任矩阵

字段 → 填充模块 → 触发时机一一对应。**agent 列永远是 ❌**。

| Envelope 字段 | 填充模块（代码） | 触发时机 | agent 参与？ |
|---|---|---|---|
| `protocol.call_id` | `envelope-builder.ts` | 消息出站，`uuid()` | ❌ |
| `protocol.parent_call_id` | `call-registry.ts` | 取发送者当前活跃 call 栈顶 | ❌ |
| `protocol.root_call_id` | `call-registry.ts` | 沿 parent 追到根 | ❌ |
| `protocol.issuer_id` | 消息出站钩子 | = 发送者 agent ID | ❌ |
| `protocol.convener_id` | `mention-router.ts`（语义反推） + API 显式传参兜底 | 默认 `parent.issuer`；有「帮/代/替」触发词则豁免 | ❌（agent 写自然语言，router 推断） |
| `protocol.on_behalf_of` | `mention-router.ts` | 同上触发词词典 | ❌ |
| `protocol.reply_to` | 消息出站钩子 | = issuer 的回执入口 | ❌ |
| `protocol.deadline` | 配置 + `envelope-builder.ts` | 默认值或 call type 规则 | ❌ |
| `task.render.displayMode` | `envelope-builder.ts` 规则 | 有 parent=`nested`；无 parent=`inline`；slash command=`background` | ❌ |
| `task.task`（β 路径） | `envelope-builder.ts` | 常量 `"conversation"` | ❌ |
| `task.task`（γ 路径） | `cross-role-handoff` skill 模板 | skill 参数表 | ✅（通过填 skill 参数间接提供） |
| `task.input.source_message`（β） | `envelope-builder.ts` | agent 的原文整段 | ❌ |
| `task.input / expected_output / constraints`（γ） | skill 模板 | skill 参数 | ✅（同上） |
| `task.context.burst` | 消息总线滑动窗口服务 | 出站时取最新窗口快照 | ❌ |
| `task.context.tombstone` | 超时检测器 | deadline 到期自动标 | ❌ |
| `task.context.rolling_summary` | 后台摘要服务 | 定期生成 / 触发式 | ❌ |

### 模块归属 Phase

| 模块 | Phase |
|---|---|
| `call-registry.ts` / `envelope-builder.ts` / `mention-router.ts` (三层 @ + on-behalf) | **Phase 1** |
| 超时检测器 + tombstone 填充 | Phase 3 |
| rolling_summary 后台服务 | Phase 3 |
| 前端 `displayMode` 渲染（溯源胶囊/嵌套/并列/淡紫色） | Phase 5 |
| `cross-role-handoff` skill 模板微调（γ 路径入口） | Phase 1 收尾同步改 skill |

---

## 附录 C · 完整数据流（agent 嘴边 → 对方眼前）

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

### 三点本质

1. **agent 只写自然语言 + 读自然语言**。它不看 Envelope、不填 Envelope、不知道 Envelope 存在。
2. **"帮小孙"三个字**就是 on-behalf 语义反推的输入 —— 语言即协议，agent 天然会说。
3. **收敛路径分歧**完全由 router 层根据 `convener_id` 决策，agent 不需要记"收敛权是否可转让"这种规则。

## Consequences

### Positive

- (+) agent prompt 永久保持精简（身份 + Iron Laws + Skill 路由 + 流程链），不随协议演进膨胀
- (+) 协议靠机器强制而非 agent 自觉，fail-closed 强度更高
- (+) Envelope 字段后续演进不影响 agent prompt（不需要重新训练/微调 agent 对协议的理解）
- (+) 拟人化自然达成：agent 就是在说话，复杂度住在下层
- (+) β/γ 分流让「正式交接」依然能走结构化契约，不牺牲 cross-role-handoff skill 价值

### Negative

- (−) mention-router / envelope-builder 的代码复杂度上升（但本来就该在那承担）
- (−) Phase 1 落地时必须严格守住「禁止改 CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts」的 diff 门禁
- (−) 桂芬 R2 那条「更新 CLAUDE.md UX 规范」的动作项作废，需在 room 里明说落点改为 spec + 前端代码（非否定她的字段设计）

### Neutral

- (=) `cross-role-handoff` skill 保持独立演化，不被 A2A 默认流程吞并

## Alternatives Considered

| 选项 | 否决原因 |
|---|---|
| (a) CLAUDE.md 里加 A2A 使用规则 | 违反 agent prompt 最小化原则，每 agent 每轮永久成本 |
| (b) agent prompt 教「行首 @ 是指令，文中 @ 是提及」 | 协议应靠机器强制；agent 自然语言生成不稳定 |
| (c) 所有 A2A 走 `cross-role-handoff` skill 默认结构化 | 违反「拟人化 = 原文直达」；95% 日常对话被 skill 模板吞噬 |
| (d) 全部自由原文，不打 Envelope | 丢失收敛权/超时/嵌套/并列卡片所有能力 |

**(Round 2 版本 §6.4 SOP 建议原先倾向 (a)，被小孙识别为方向错误，本 ADR 取最终方向 = β/γ 分流 + 透明原则)**

## Rollout Plan

- **Phase 1**：
  - envelope-builder.ts / call-registry.ts / mention-router.ts 三件套
  - β/γ 双路径代码分流
  - a2a_calls 表扩字段
  - **diff 门禁**：CI 检查 `CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts` 四个文件的尺寸与 `main` 保持一致或更小
- **Phase 5**：前端根据 Envelope 字段自动渲染（溯源胶囊 / 折叠 / 并列 / 淡紫色）
- **整个 F026 Phase 链**：严禁向 agent prompt 层添加 A2A 协议内容

## Verification

- Phase 1 AC：
  - [ ] `CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts` 相对 main 行数差为 0（允许 -N）
  - [ ] β 路径 outbound 消息 `task.task === "conversation"` + `task.input.source_message === 原文`
  - [ ] γ 路径（`cross-role-handoff` skill 调用）outbound `task.task !== "conversation"` + 结构化字段全填
  - [ ] Envelope.protocol 所有 8 个字段在 outbound 时全部非空（除 on_behalf_of 可空）
  - [ ] agent 测试 fixture：模拟 agent 写「@B 帮小孙 review」，验证 envelope 里 `convener_id === "小孙"`

## References

- Round 2 讨论收敛报告：`docs/discussions/F026-design-discussion-round-2.md` §6.3 ADR-004 草案 + 附录 A/B/C
- 小孙 2026-04-23 PM 对话（room）：两轮明确拒绝往 CLAUDE.md 塞 A2A 规则
- F026 spec：I11 不变量
- ADR-002：提供 Call Tree 字段（本 ADR 的 Envelope.protocol 层数据源）
- ADR-003：提供 @ 识别 + on-behalf 反推（本 ADR 的 Envelope.protocol.convener_id / on_behalf_of 数据源）
