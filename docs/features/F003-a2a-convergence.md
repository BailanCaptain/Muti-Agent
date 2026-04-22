---
id: F003
title: A2A 运行时闭环 — 回程派发 + Stop Reason 续写 + SOP 派发
status: done
owner: 黄仁勋
created: 2026-04-11
completed: 2026-04-11
---

# F003 — A2A 运行时闭环

**Created**: 2026-04-11
**Completed**: 2026-04-11

## Why

小孙在真实使用中反复踩到三类症状，历史多次补丁（改 skill、改 prompt、加 settlement 状态机）都没有真正解决：

1. **会话突然截断**（12:44 案例）：黄仁勋一条 reply 生成到一半就停，前端看起来是"仁勋突然不干活了"。小孙只能手动问"你为什么停了"。
2. **流程不推进**：quality-gate 完成后应自动进入 requesting-review，但不会动。小孙要手动 `@黄仁勋 去请求 review`。
3. **A2A 不收敛**：发出 review 请求给德彪，德彪给出完整 review 后（13:14 案例），黄仁勋不会被自动唤起进入 receiving-review。小孙要手动"德彪给你 review 了你看一下"，当人肉 router。

### 小孙原话（立项依据，不可删）

> 修改bug A2A我们已经修改了很多次的 一定要定位到根因 彻底解决 如果是架构问题该整改就整改

> 1、黄仁勋再12：44这个会话里突然截断，停止运行，从我的视角来看就是突然停止了任务
> 2、流程根本不推进，quality-gate之后应该去请求review，但是仁勋没有
> 3、流程不推进的情况下 我手动让仁勋去请求review，明明已经加载了review request，但是A2A根本不会主动收敛，流程也不会推进，request-review明确写了"Review 请求发出后 → 等 reviewer 回复 → **直接进入 `receiving-review`** 处理反馈。" 但是根本不按这个走，本来应该是A2A需要发起方收敛，然后前端会有变化，但是仿佛完全不按我设想的走

> 要求：必须参考reference-code下面的三个最佳实践，我觉得根本不是skills、prompt的问题

关于截断的追问：

> block3是否还有深层次的原因 比如CLI自动触发了压缩 导致截断 在我的视角来看 无论什么情况下 除了网络等特殊情况 CLI本身的操作在前端就不应该截断 包括codex gemini CLI是不是都可能有这个截断的问题 这个体验太差了

关于续写上限和 skill 改动的确认：

> 1、拉满 用户体验上来看 就是要全部看到的
> 2、可以 只要能彻底解决这个问题

### 根因（架构级，一句话）

**A2A 管线是纯 pull-based 的文本扫描模型**：`message-service.runThreadTurn` 结束后靠正则扫 CLI stdout 里行首 `@alias` 决定下一跳。三个症状都是这个模型的必然失效：

| 症状 | 现有代码位置 | 根因细节 |
|---|---|---|
| 截断 | `base-runtime.ts:385` `extractFinalText` | 只看 exitCode + rawStdout，**完全不解析 stream-json 里的 `stop_reason` / `finish_reason`**。`max_tokens` / `refusal` 等被误判为 `end_turn`，半截内容当 final 落盘。Claude / Codex / Gemini 三个 runtime 对称盲点。 |
| 不推进 | `message-service.ts:1831` `advanceSopIfNeeded` | SopTracker 只更新 stage 字段，不派发。skill 文本里写的"进入下一 stage"是给 LLM 看的意图，runtime 无执行器。 |
| 不收敛 | `dispatch.ts:98` `bindInvocation` | `parentInvocationId` 字段存了但**全仓无任何消费者**。子 invocation 完成后没有"返程"路径，完全靠子 agent 的 LLM 自己写 `@父` 才能收敛。 |

### 参考实现（reference-code/clowder-ai）

`packages/api/src/domains/cats/services/agents/routing/route-serial.ts` + `WorklistRegistry.ts`：**一次 routeSerial = 一个 worklist + 一个 while 循环**。A→B→A 整条链跑在同一个函数栈，子 cat 的 mentions push 回同一个 worklist，MCP 回调也通过 `pushToWorklist(parentInvocationId, ...)` 注入同一个 worklist。F003 不会照搬（我们用多 provider CLI 子进程，无法共享一个 async generator），但会把**"同一条 A2A 链显式化 + 回程必达"**这个核心不变量搬过来。

## What

让用户从**前端视角**看到的 A2A 流程 **100% 运行时闭环**：
- CLI 层任何 stop reason / 截断 / 续写对前端**完全隐形**（一条 bubble 连续流式追加）
- SOP 阶段转换**自动派发**（不依赖 LLM 自己写 @mention）
- 子 agent 回复完成后**必定回程到发起方**（不依赖子 agent 的文风约定）

不是 skill / prompt 层的 band-aid，是 runtime 层的架构整改。

## Acceptance Criteria

### AC1 — Stop Reason 感知（Phase 1）
- [x] `BaseCliRuntime` 新增 `parseStopReason(event)` 抽象方法，返回 `"complete" | "truncated" | "refused" | "tool_wait" | "aborted" | null`
- [x] `ClaudeRuntime` 从 `result` event 的 `stop_reason` 映射：`end_turn → complete`、`max_tokens → truncated`、`refusal → refused`、`tool_use → tool_wait`
- [x] `CodexRuntime` 从 task.complete / finish_reason 对称实现
- [x] `GeminiRuntime` 从 `finishReason` 对称实现（`STOP → complete`、`MAX_TOKENS → truncated`、`SAFETY → refused`）
- [x] 进程退出但未见 `result` event → `aborted`
- [x] `AgentRunOutput` 新增 `stopReason` 字段，单测覆盖所有分支

### AC2 — 透明续写管线（Phase 2）
- [x] `runThreadTurn` 读到 `stopReason === "truncated"` 或 `"aborted"` 时：**不**把内容当 final，自动发一轮续写 prompt"你上一轮被截断，请无缝续写，不要重复"
- [x] 续写结果 **append 到同一条 assistant message**，前端看到一条 bubble 在流式追加
- [x] 续写无硬上限（小孙要求"拉满"），但有**重复检测**：连续 2 次续写产出 <50 字有效内容 → 中止，避免死循环
- [x] 续写期间 settlement detector 视为 in-flight（不触发 flush）
- [x] 续写链消耗的 usage 走 seal decision，触发 seal 则中止续写并 emit status
- [x] 单测覆盖：max_tokens 续写 1 次 / 3 次 / 重复检测中止 / seal 触发中止
- [ ] 前端单 bubble 无感续写（手动验证：构造一个会触发 max_tokens 的长 prompt）

### AC3 — A2A Invocation Chain & 回程派发（Phase 3）
- [x] 新增 `orchestrator/a2a-chain.ts`：以 `invocationId` 为键维护 `A2AChainRegistry`，记录每条链的 invocation 栈（parent → child 关系）
- [x] `runThreadTurn` 完成后，若 child 的 reply 不含出站 mention 且 `parentInvocationId` 存在且 parent 可回程 → 自动合成一跳"A2A 回程派发"
- [x] 回程 payload：`[${childAlias} 的 ${skill名} 答复]\n\n{childContent}\n\n请继续你的流程` 投递到 parent 的 thread
- [x] 去重：child 已经写了行首 `@parentAlias` 则不回程（走老路径即可）
- [x] 去野跑：parent thread 已开新 rootMessageId 则不回程
- [x] 去环：复用现有 `MAX_HOPS=15`（enqueuePublicMentions 自带）
- [ ] 前端标记：A2A 回程消息的 connector header 显示"A2A 回程 — {child} → {parent}"（后端 emit 了 `status` 事件包含该文案，connector header 纯视觉改动留待 F003 后续 enhancement）
- [x] 单测覆盖：正常回程 / child 显式写 @parent 不重复 / parent 新 turn 则放弃 / 达到 MAX_HOPS 阻断
- [ ] 手动验证：小孙 13:14 场景复现 — 德彪完成 review 后仁勋自动进入 receiving-review

### AC4 — SOP-driven Dispatch（Phase 4）
- [x] skill manifest 新增 `next_dispatch` 字段：`next_dispatch: { target, prompt_template }`（真相源在 `multi-agent-skills/manifest.yaml`，skill frontmatter 保持不动）
- [x] `requesting-review` 填写 `next_dispatch`（quality-gate → vision-guardian → requesting-review 是同 agent 内顺序推进，真正需要跨 agent 交接的点是 requesting-review）
- [x] `SopTracker.advance` 返回 `SopAdvancement` 结构体（含 `nextStage` / `nextDispatch`）
- [x] `advanceSopIfNeeded` 检测到 `nextDispatch` → 通过 `planForcedDispatch` + `enqueuePublicMentions` 合成 @-mention，不等 LLM 自己写
- [x] 去重：LLM 已经在行首写了对应 @alias 时 `planForcedDispatch` 返回 null
- [x] 单测覆盖：nextDispatch 解析 / SopAdvancement 传递 / planForcedDispatch 所有分支 / reviewer-resolver 三 provider
- [ ] 手动验证：quality-gate 结束后无需小孙手动推，requesting-review 自动启动

### AC5 — 愿景对照（Completion 时必做）
- [~] 三个症状全部**前端可见地**消失：无截断、无手动推流程、无人肉 router
- [~] 小孙在一条新会话里按 feat-lifecycle 跑一个小 feature 从 kickoff 到 merge，全链路**零手动干预 A2A**
- [~] 证物：完整会话截图 / sqlite 轨迹 + `git log --grep F003` PR 列表

> **归档说明（2026-04-11）**：小孙授权直接归档，AC5 的前端手动验证不再作为收尾条件。
> 后续真实使用中若任一症状复现，作为 bug（B 级）单独立项而非重开 F003。

## Dependencies

**无阻塞依赖**（F001 / F002 都已完成）。

**内部依赖顺序**（Phase 之间）：
- Phase 1（stop reason parser）→ 独立可落地，最小风险
- Phase 2（续写管线）← 依赖 Phase 1
- Phase 3（回程派发）← 依赖 Phase 2（续写稳定后回程内容才可信）
- Phase 4（SOP 派发）← 依赖 Phase 3（SOP 派发可能触发回程）

**技术依赖**：
- Claude Code CLI 的 `stream-json` 输出格式（已使用，无需改变）
- Codex CLI 的 event stream（现有 codex-runtime.ts 已解析部分）
- Gemini CLI 的 `finishReason` 字段（现有 gemini-runtime.ts 已读 usage）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| **是否照搬 clowder-ai 的 WorklistRegistry** | A) 完全照搬 worklist + routeSerial 单 async generator / B) 保留现有 dispatch queue，只引入 parent tracking + 回程 | **B** | 我们跨 provider 子进程 CLI，无法共享一个 async generator 栈；现有 dispatch queue 已稳定，只缺 parent 维度。B 方案爆炸半径小。 |
| **续写次数上限** | A) 固定 3 / B) 固定 10 / C) 无硬上限 + 重复检测 | **C** | 小孙原话"拉满 用户体验上来看就是要全部看到的"。重复检测：连续 2 次续写 <50 有效字符 → 中止，防死循环。 |
| **回程消息的归属** | A) 回程到 parent 的 thread / B) 留在 child thread 但触发 parent 的 turn | **A** | parent 的 feat-lifecycle 上下文都在 parent thread，回到 parent thread 符合 skill 的"直接进入 receiving-review"语义，前端也直观。 |
| **SOP 派发 vs LLM 自由意志** | A) 运行时强派 / B) 只建议 + 让 LLM 决定 | **A + 去重** | 历史证明靠 LLM 的文风约定不靠谱。去重机制（invocationTriggered）保证 LLM 自己写了 @ 时不重复。 |
| **Phase 顺序** | A) 先做最容易的 SOP / B) 先做最痛的截断 | **B**（Phase 1→2→3→4）| 截断是最伤体验的，Phase 1-2 独立于其他可先落地；Phase 3 依赖续写稳定；Phase 4 依赖回程稳定。串行减少集成风险。 |
| **skill frontmatter 新增 `next` 字段** | A) 改 skill / B) 硬编码映射表 | **A** | 小孙明确授权"只要能彻底解决就可以"。skill 是真相源，映射表会漂移。 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-11 | Kickoff — F003 立项 |
| 2026-04-11 | Phase 1 代码完成：StopReason 类型 + 三 runtime parseStopReason + cli-orchestrator 传播 |
| 2026-04-11 | Phase 2 代码完成：ContinuationGuard + runContinuationLoop + SettlementDetector in-flight + MessageService 接线 |
| 2026-04-11 | Phase 3 代码完成：A2AChainRegistry + planReturnPathDispatch + MessageService 接线 + 2 min chain TTL |
| 2026-04-11 | Phase 4 代码完成：SkillMeta.nextDispatch + SopTracker.advance 返回 SopAdvancement + reviewer-resolver + planForcedDispatch + manifest `requesting-review.next_dispatch` |
| 2026-04-11 | 全量测试 385/388 pass（3 失败为 F003 之前的 baseline 问题：gemini parseAssistantDelta × 2, phase1-header × 1，不在本 feature scope）|
| 2026-04-11 | Squash merge 到 dev — 18 个 atomic commit 整合为单 feat(F003) commit |

## Links

- Discussion: 本次对话（2026-04-11）
- Plan: `docs/plans/F003-*.md`（待 writing-plans 生成）
- Related: B003（feat-lifecycle 双重进入，已修复）、B004（settlement premature，已修复）、F019（告示牌机制 — next_dispatch 与 sopStageHint 同属 SOP 推进层不同层级）
- Reference: `reference-code/clowder-ai/packages/api/src/domains/cats/services/agents/routing/`（WorklistRegistry / route-serial.ts）

## Evolution

- **Evolved from**: 无直接前序 Feature。继承 B003/B004 暴露出来的 A2A 管线脆弱性。
- **Blocks**: 未来所有依赖"跨 agent 自动协作"的 Feature（review 自动化、SOP 自动推进、并行讨论收敛）
- **Evolved to**: **F026（A2A 可靠通信层）** — 2026-04-22 立项。基于全量 DB 扫描（R-184 双消息偶发、P5 空壳 10.84%、P6 窜房间 14.38%）+ Clowder 源码逆向，定位到本 feature 的 `return-path` 启动新 invocation 是 R-184 双消息根因（抄 Clowder worklist 抄错）。F026 将废除 `return-path.ts` 的 new-invocation 路径，改为同一 routeSerial 内 `worklist[++index]` 续推，同一 turn 不产生两行 DB message。
- **Related**: F002 Decision Board（settlement detector 需与续写/回程协同，不能把续写中的 turn 当 settled）· F019 Skill 告示牌（状态机 + sopStageHint 注入，与 next_dispatch 正交）
