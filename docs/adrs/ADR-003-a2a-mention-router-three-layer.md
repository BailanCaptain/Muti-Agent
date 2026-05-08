---
id: ADR-003
title: A2A @ 识别策略 — 三层 fail-closed + on-behalf 语义反推
status: Amended
feature: F026
date: 2026-04-23
approved_by: 小孙（Design Gate D4）
amended: 2026-05-08
amended_by: 黄仁勋（小孙 2026-05-08 拍板"今日闭环 · 改 ADR 不改实现"）
implementation_status: partial · Layer 1/3 + on-behalf + 反循环去重落地原样；Layer 2 hard-positive 在 P3 (2026-04-27) 被「方案 X · `[Call: @名 描述]` 显式调用标签」取代
supersedes: F026 P0 Task 6「assistant role 守卫」（该机制 Phase 0 止血保留，Phase 1 由本 ADR 替代）
related: ADR-002, ADR-004
---

# ADR-003 · A2A @ 识别三层 fail-closed + on-behalf 语义反推

## Context

A2A 派发错误是 F026 最高频痛点，历史上多次在房间现场翻车：

| 时间 | 场景 | 错误派发 |
|---|---|---|
| 2026-04-22 15:30 | agent 回复里展示代码块示例 | 代码块内 `@范德彪 @桂芬` 被识别为真派发 |
| 2026-04-22 16:05 | 文本里出现 `**@范德彪**` 粗体装饰 | 被误派 |
| 2026-04-23 11:43 | 黄仁勋发给小孙的简报里 code block 内出现 "at 桂芬" | 桂芬被激活，扩展写了一大段，触发 F026 S3 + S6 级联事故 |

F026 P0 Task 6 的**热修**是「assistant role 守卫」——`mention-router` 对 assistant 消息直接返回空。这在 Phase 0 止血有效，但：

1. 仍不能防 user 消息里 code block 内的 `@`（LL-028 就是 user 消息）
2. 仍不能防 `**@X**` / `@X 是 Y`（介绍句式）这种 hard-negative 场景
3. 无法表达「A 代表小孙拉 B」这类**正确的派发 + 收敛权豁免**——现状只能派发或不派发二选一

Round 2 讨论中，**协议模型层**（范德彪 Q2：三层混合 + fail-closed）和 **UX 层**（桂芬 R1 意图嗅探：行首 @ vs 文中 @）**独立撞到同一条规则**，置信度最高。

## Implementation Note · 2026-05-08 追认（小孙："今日闭环 · 改 ADR 不改实现"）

> 这一节是**追认**，不是新决策。F026 在 2026-04-23（本 ADR）→ 2026-04-27（P3.1 retry guard）的两周里因为反复出 R-053 / R-054 / 房间级联误派事故，**Layer 2 hard-positive 已在代码里被替换**。今日（2026-05-08）小孙拍板"今天闭环 · 改 ADR 不改实现，以后想改在新 feature 起"——故而把现实状态写进 ADR 让文档与代码一致，不重做架构。
>
> **以下小节里 Layer 2 的"行首 @ + 50 动词词典 + alias"叙述保留作历史记录**，实际现行规则以本节为准。

### 实际现行规则 · 方案 X · `[Call: @名 描述]` 显式调用标签

`mention-router.ts:resolveCallTagMentions`（参见 `mention-router.call-tag.test.ts`）：

| 来源 | 真实派发规则 |
|---|---|
| **agent (role=assistant)** | **自由文本里的 `@xxx` 一律不派发**；要派发**必须**用 `[Call: @X 任务描述]` 显式标签 |
| **user (role=user)** | 仍走 Layer 1 hard-negative（code block / `**@X**` / 介绍句式 fail-closed） + 行首/句中 alias 派发；不依赖 `[Call:]` |

### 为什么 Layer 2 被替换

- 50 个动词白名单 + 礼貌前缀 + 子句猜测路径**永远在追补丁**：每加一个 LLM 写法风格就要补词典；2026-04-27 R-053 / R-054 又翻车
- 显式标签让 agent **显式声明意图**，机器**一票通过 / 一票否决**；歧义清零
- 教 agent 一个简单语法（`[Call: @X 描述]`）的代价 << 维护动词词典

### 配套 retry guard（P3.1 · 2026-04-27 落地）

- `mention-router.ts:detectInvalidDispatch` 检测两类违例：
  - `nested_call_tag` — `[Call: ... [Call: ...] ...]` 嵌套（B021 R-045 教训）
  - `naked_at_with_real_teammate` — 行首裸真实队友 `@` 但全文无合法顶层 `[Call:]` 包装（R-053 / R-054 兜底）
- 命中后向 LLM **重试 3 次** + WS event `dispatch_validation_retry` 实时广播；3 次仍失败则 final 入库 + 前端硬警示"派发未触发，请手动 @ 触发"

### 仍然生效的部分（与原 ADR 一致）

- ✅ **Layer 1 hard-negative**：code block / inline code / blockquote / table 单元格 / `**@X**` 装饰 / 介绍句式（`@X 是 Y` / `@X 老师`）—— `maskHardNegativeRanges` 实现
- ✅ **Layer 3 gray-zone**：默认 fail-closed 不派 + `mention.gray_zone` WS 事件实时广播（P5 T2 灰区可观测层）
- ✅ **on-behalf 语义反推**：「帮/代/替/为 X + @B」→ `convener_id=X` 豁免严格分级
- ✅ **反循环 + 去重**：30 秒滑窗 + 单消息单 target ≤ 1 派；traceId 全链路

### 与 ADR-004 透明原则的关系

`[Call:]` 是**消息内的派发意图语法**，不是 Envelope 协议字段。agent 仍**永不感知** `call_id / parent_call_id / convener_id / on_behalf_of` 等任何 protocol 字段——那些字段由 `envelope-builder.ts` + `call-registry.ts` 在出站时自动填。但 ADR-004 "agent 不感知任何协议内容"的纯净版被打破——详见 ADR-004 Implementation Note。

---

## Decision（原始 · 2026-04-23 · 历史保留）

`mention-router.ts` 升级为**三层 fail-closed** + **on-behalf 语义反推**。

### Layer 1 · hard-negative（一票否决）

以下场景**无论消息 role 如何，一律不派发**（只保留前端视觉高亮）：

| 场景 | 检测方式 |
|---|---|
| Markdown fenced code block ` ``` ` | Markdown-AST 识别节点类型 |
| Inline code `` `@X` `` | Markdown-AST |
| Blockquote `> @X` | Markdown-AST |
| Table 单元格内 `@X` | Markdown-AST |
| 装饰性粗体斜体 `**@X**` / `*@X*` | Markdown-AST strong/em 节点 |
| 名册 / 介绍句式 `@X 是 Y / @X 老师 / 与 @X 讨论` | 规则：`@X` 后跟 [是\|的\|老师\|先生\|同学] 或 `@X` 前跟 [与\|和\|及] |
| "at X"（英文代词） | hard-negative 词典 |

### Layer 2 · hard-positive（派发）

**全部满足**才派发：

1. **行首 `@`**（`@` 前只有空白或行起点）
2. **指令/请求语义**：`@X + 动词`（看/帮/做/写/检查/review/...）或 `@X + 问句`（?/？）或 `@X + 任务描述`（非纯名词）
3. **明确动作对象**：`@X` 解析到已注册 alias 且在当前房间 roster

### Layer 3 · gray-zone（默认不派 + 日志）

不满足 Layer 1/2 的灰区：
- **默认 fail-closed 不派发**，记 debug 日志
- Phase 5 引入轻量分类器（可选 LLM）基于上下文二次判定
- Phase 1 纯规则骨架够用

### on-behalf 语义反推（与三层识别同层）

`mention-router` 同时做 **on-behalf 反推**（见 Round 2 §6.2 补充章节）：

| 自然语言信号 | 反推字段 | 示例 |
|---|---|---|
| 「**帮** X + @B」、「**替** X + @B」、「**代** X + @B」、「**为** X + @B」 | `on_behalf_of = X`，`convener_id = X`（ADR-002 豁免严格分级） | A 说「@B **帮**小孙 review 一下」→ B 的回执直达小孙，不经 A |
| 「@B +（仅 X 参考）」 | `on_behalf_of = X`（观众视角，不转收敛权） | A 叫 B 但结果让 X 看，A 仍收敛 |
| 无上述信号 | `on_behalf_of = null`，`convener_id = parent.issuer`（默认） | 普通 @B，严格分级 |

**实现约束**：

- 词典**规则优先**（Phase 1 纯规则够用）；LLM fallback 留 Phase 5
- 模糊 / 冲突时 **fail-closed**（默认不豁免、走严格分级）
- 词典配置**外挂**（JSON / YAML），不硬编码，后续加词不改代码
- 所有派发决策生成 `traceId`，写日志便于事后核查

### 反循环与去重（原 I7 吸收）

同一 `mention-router` 出入口额外保证：

- **30 秒滑动窗口**：同 `(source_agent, target_agent)` 内只派发一次，DB 记录 `last_dispatch_at`
- **单消息内去重**：同一消息同一 target 最多派发 1 次（即使行首 @ 出现 N 次）
- **traceId 全链路**：UI 可见「这条消息派发了 X 给 Y（原因）」

## Consequences

### Positive

- (+) 三场翻车（2026-04-22 × 2 + 2026-04-23 级联）全部归零
- (+) 对齐业界 bot 平台铁律（Slack/Discord/GitHub bot）同时支持**正确的 A2A 派发**（行首 @ + 动作语义）
- (+) on-behalf 反推让「A 代表小孙拉 B」这类正确语义通过**自然语言**表达，agent 不需要填任何字段（配合 ADR-004 透明原则）
- (+) traceId + 日志让误派发事后可诊断，不再是黑箱
- (+) 反循环与去重从根本上防止 agent 间 @ 的级联爆炸

### Negative

- (−) Markdown-AST 解析增加 mention-router 的复杂度（需引入 unified/remark 或等价库）
- (−) on-behalf 词典需维护中文语料；第一期可能漏词（fail-closed 默认不豁免兜底，漏判最多损失语义豁免能力，不产生错误派发）
- (−) 规则层堆叠多，需要全面的 fixture 覆盖——测试矩阵扩到 ~30 条 red-case + ~15 条 green-case

### Neutral

- (=) P0 Task 6 的「assistant role 守卫」继续保留到 Phase 1 切换：Phase 0 止血用，Phase 1 落地后由三层识别替代

## Alternatives Considered

| 选项 | 否决原因 |
|---|---|
| (a) 纯正则 | 每加一种反模式就要改 regex，永远追着补丁跑（历史教训） |
| (b) 仅 role 守卫（P0 Task 6） | 防不了 user 消息 code block 内 @（LL-028 就是 user → 实测翻车） |
| (c) 只做 AST，不做 on-behalf 反推 | 无法表达「A 代表 caller 拉 B」的收敛权豁免，强迫 agent 填 Envelope 字段（违反 ADR-004） |
| (d) AST + LLM 分类器一期到位 | LLM 调用延迟 + 成本 + 不可解释性；Phase 1 纯规则骨架够用，灰区分类器留 Phase 5 |

## Rollout Plan

- **Phase 0 (当前)**：P0 Task 6 assistant role 守卫止血
- **Phase 1**：
  - Markdown-AST 集成（unified/remark-parse）
  - Layer 1 hard-negative 规则（7 场景）
  - Layer 2 hard-positive 规则
  - Layer 3 gray-zone 默认不派
  - on-behalf 词典骨架（中文「帮/代/替/为」）
  - 反循环 & 去重（DB `last_dispatch_at`）
  - ≥ 30 条 red-case fixture + ≥ 15 条 green-case fixture（覆盖 LL-028 级联事故）
- **Phase 5**：灰区轻量分类器（可选 LLM）+ 溯源胶囊 UX

## Verification

- Phase 1 AC：
  - [ ] 2026-04-22 两次翻车 red-case 归零
  - [ ] 2026-04-23 Round 2 讨论级联事故 red-case 归零（LL-028）
  - [ ] 「A @B **帮**小孙 review」→ `on_behalf_of=小孙, convener=小孙` 单测绿
  - [ ] 同 `(source, target)` 31 秒内两次派发，第二次 blocked 且记日志
  - [ ] 单消息内 3 次 `@X` → 1 次派发

## References

- Round 2 讨论收敛报告：`docs/discussions/F026-design-discussion-round-2.md` §Q2 / §6.2（含 on-behalf 补充章节）
- F026 spec：I1' 不变量
- LL-028：mention-router 必须过 Markdown AST
- P0 Task 6：`docs/plans/F026-p0-plan.md` Task 6（role 守卫止血）
- ADR-002：消费本 ADR 的 `convener_id / on_behalf_of` 输出
- ADR-004：本 ADR 产出的字段由 envelope-builder 打入 Envelope.protocol
