---
id: F007
title: 上下文压缩优化 — Microcompact + SOP书签 + 自动续接 + 动态预算 + 语义检索 + 摘要增强 + F-BLOAT检测 + 观测指标 + UX
status: done
completed: 2026-04-14
owner: 黄仁勋
created: 2026-04-13
---

# F007 — 上下文压缩优化

**Created**: 2026-04-13

## Why

F004 解决了"历史由服务端权威持有"的根基问题，但长对话中 agent 仍然会因 seal（上下文封存）而丢失工具输出细节、skill 执行阶段、中间段关键决策。小孙实际体验中的核心痛点：seal 触发后 agent 停工、需要手动重新召唤；工具输出被一刀切截断导致"知道改了但不知道改成啥"；skill 阶段跨 seal 断片。

### 小孙原话（立项依据，不可删）

> 我们当前上下文满了之后的压缩是怎么做的？每个CLI我记得会有自己的压缩策略，我们是保留了他们本身的压缩能力，还是直接覆盖了？

> 假设触发了seal 能不能不中断 自动进行呢 不然我让大家修改的时候 突然触发seal 那你们就停了 我可能出门了 回来发现还是中断在这

> 要做就做好 不要什么中期前期后期的 要做就一次做好

### 根因分析（三人协作讨论，基于代码 + reference-code 对比）

1. **工具输出无差别截断**：历史注入时工具结果与普通消息混在一起，超过 N 条统一截掉，丢失关键 diff/stderr/路径信息
2. **seal 断崖式停工**：`continuation-loop.ts:51-56` seal 后直接 break，无自动续接机制
3. **skill 状态不持久**：seal 后新 session 不知道 agent 处于 TDD Red/Green/Review 哪个阶段
4. **历史注入硬限写死**：`POLICY_FULL` 的 30/15/2000 不根据窗口余量动态调整
5. **CLI 自行压缩不可感知**：CLI 黑箱压缩可能吞掉 system prompt 关键信息
6. **摘要取样窗口窄**：Gemini 只取最近 50 条 × 500 字，extractive 兜底质量差
7. **中间段信息丢失**：只保留最近 N 条，第 5 轮的架构决策、第 12 轮的 bug 根因被截掉

### Reference-Code 对比（三个最佳实践）

| 能力 | 我们 | OpenHarness | clowder-ai | deer-flow |
|------|------|-------------|------------|-----------|
| 廉价预处理 | **无** | Microcompact（零 LLM，清旧工具结果） | extractive digest（规则提取） | 无 |
| 压缩策略 | 单一 seal | 两级（micro + full LLM） | 三策略可选(handoff/compress/hybrid) | LangChain middleware |
| 工具输出 | 混在消息里 | 分级保留（近 5 个完整） | 工具名+路径存 digest | 不特殊处理 |
| 跨压缩恢复 | 摘要+历史注入 | session JSON | **SOP 书签** + digest | checkpointer |
| token 预算 | 硬编码 | 动态（窗口-33K） | 分层预留 | 可配置阈值 |

## What

9 个模块一次做完，让 agent 在长对话中**不丢记忆、不断片、不停工**。

| # | 模块 | 一句话 |
|---|------|--------|
| 1 | Microcompact | 零 LLM 开销，旧工具输出替换为带锚点占位符，保留最近 N 个完整 |
| 2 | SOP 书签 | 结构化 skill 状态跨 seal 恢复，前端面包屑导航 |
| 3 | Seal 自动续接 | seal 后自动注入系统消息开新 turn，最多 2 次，不停工 |
| 4 | 动态 token 预算 | 根据 fillRatio 动态伸缩历史注入量，不再写死 30/15/2000 |
| 5 | 渐进式老化 | 本地 embedding（all-MiniLM-L6-v2）+ better-sqlite3 暴力余弦搜索，按需召回中间段历史 |
| 6 | 摘要增强 | 扩大取样窗口、结构化 extractive Timeline、摘要 Provider Fallback 链 |
| 7 | F-BLOAT 检测 | 检测 CLI 自行压缩，强制重注入 system prompt |
| 8 | 观测指标 | seal/fallback/compact/书签恢复率等全程可观测，SQLite + WebSocket 推送 |
| 9 | UX 层 | seal 瞬态提示、SOP 面包屑、上下文健康度仪表盘 |

## Acceptance Criteria

### 模块一：Microcompact
- [x] AC1.1: 新建 `packages/api/src/orchestrator/microcompact.ts`，导出 `microcompact(messages, config)` 函数
- [x] AC1.2: 在 `context-assembler.ts` 构建 `contentSections` 阶段调用 microcompact，仅改注入视图
- [x] AC1.3: 保留最近 5 个工具结果完整内容；保留最近 1 个失败结果（exit code !== 0 / stderr / Error）原文
- [x] AC1.4: 其余工具结果替换为带锚点占位符：`[工具结果已压缩] msgId=xxx | tool=名称 | path=路径 | exit=码 | at=时间`
- [x] AC1.5: SQLite 原始记录不被修改（铁律：数据神圣不可删）
- [x] AC1.6: `roomSnapshot` 本身不被修改，其他 agent 的注入不受影响
- [x] AC1.7: 单测覆盖：输入 10 条工具消息，验证输出只保留最近 5 条完整 + 1 条最近失败

### 模块二：SOP 书签
- [x] AC2.1: 定义 `SOPBookmark` 类型：`{ skill, phase, lastCompletedStep, nextExpectedAction, blockingQuestion, updatedAt }`
- [x] AC2.2: SQLite `threads` 表新增 `sop_bookmark TEXT` 列
- [x] AC2.3: 每轮 turn 结束后从 agent 输出中提取 skill 阶段信息写入 `sop_bookmark`
- [x] AC2.4: `context-assembler.ts` 摘要注入时追加 `## 当前执行状态` 段（机器可读格式）
- [x] AC2.5: 单测覆盖：seal 后新 session 首轮 prompt 包含正确的 SOP 书签

### 模块三：Seal 自动续接
- [x] AC3.1: `message-service.ts` seal 处理段：seal 后检查 SOP 书签，有未完成工作则自动注入续接消息
- [x] AC3.2: 自动调用 `runThreadTurn()` 开新 turn
- [x] AC3.3: 最多自动续接 2 次（`autoResumeCount` 计数器）
- [x] AC3.4: 新 turn 首轮 token 使用率 > 50% 时不再续接（防死循环）
- [x] AC3.5: 状态栏显示 `"记忆重组中，自动续接 (1/2)"`
- [x] AC3.6: 无 SOP 书签或 2 次续接后仍未完成 → 正常停，等用户消息

### 模块四：动态 token 预算
- [x] AC4.1: `ContextPolicy` 新增 `dynamicBudget?: boolean`，`POLICY_FULL` 启用
- [x] AC4.2: `AssemblePromptInput` 新增 `lastFillRatio?: number`
- [x] AC4.3: 动态计算规则：fillRatio < 0.3 → 60/30/4000；0.3-0.5 → 40/20/3000；0.5-0.7 → 30/15/2000；> 0.7 → 15/8/1000
- [x] AC4.4: 新 session（无 fillRatio）使用默认值 30/15/2000
- [x] AC4.5: 单测覆盖各档位计算正确

### 模块五：渐进式老化（语义检索）
- [x] AC5.1: 添加 `@huggingface/transformers` 依赖，使用 `all-MiniLM-L6-v2` 本地模型
- [x] AC5.2: better-sqlite3 新建 `message_embeddings` + `message_embedding_meta` 表（普通表，非 vss）
- [x] AC5.3: 每条 agent 消息写入后异步生成 embedding（不阻塞主流程，失败静默降级）
- [x] AC5.4: 长消息按 512 token 分块，每块独立 embedding
- [x] AC5.5: `context-assembler.ts` 构建历史时额外做语义检索：当前用户消息作 query，top-5 相关历史片段，去重后以 `## 相关历史回忆` 段注入
- [x] AC5.6: 时间衰减权重：`score = cosine_similarity * exp(-age_hours / 168)`（7 天半衰期）

### 模块六：摘要增强
- [x] AC6.1: `callGeminiSummarizer` 取样窗口从 50 条 × 500 字扩大到 100 条 × 800 字
- [x] AC6.2: `buildExtractiveSummary` 改造为结构化 Timeline 格式（时间 + 人 + 动作 + 关键决策 + 未完成项）
- [x] AC6.3: 摘要 Provider Fallback 链：Gemini → 当前 agent CLI → extractive
- [x] AC6.4: Fallback 发生时记录到 metrics

### 模块七：F-BLOAT 检测
- [x] AC7.1: `cli-orchestrator.ts` 的 `computeSealDecision` 对比本轮与上轮 `usedTokens`
- [x] AC7.2: usedTokens 突降 > 40% 时标记 `fBloatDetected = true`
- [x] AC7.3: 下一轮 turn 强制重新注入完整 system prompt（即使有 nativeSessionId）
- [x] AC7.4: 同时触发摘要刷新（不等 10 条消息阈值）

### 模块八：观测指标
- [x] AC8.1: 新建 `packages/api/src/services/metrics-service.ts`
- [x] AC8.2: SQLite 新建 `context_metrics` 表
- [x] AC8.3: 记录指标：seal_count / seal_auto_resume_count / extractive_fallback_count / microcompact_tokens_saved / sop_bookmark_restore_success / sop_bookmark_restore_fail / embedding_retrieval_hit / fbloat_detected / summary_provider_used
- [x] AC8.4: WebSocket 推送指标到前端

### 模块九：UX 层
- [x] AC9.1: seal 触发时状态栏显示 `"记忆重组中..."` → 自动续接时 `"记忆重组完成，自动续接 (1/2)"` → 完成后消失
- [x] AC9.2: 顶栏 SOP 面包屑：`Skill[TDD] → Phase[Red] → 下一步: 最小实现`
- [x] AC9.3: 设置页"上下文健康度"面板：seal 频率、摘要质量、书签恢复率

### 交叉验收
- [x] AC10.1: @ 非作者 agent 独立做愿景三问 + 输出证物对照表
- [x] AC10.2: 手动场景：和 agent 长对话 20+ 轮 → 触发 seal → agent 自动续接不停工 → 续接后 skill 阶段正确

## Dependencies

- **Evolved from**: F004（上下文记忆权威化）— F004 建立了 DB 历史注入的权威源，F007 在此基础上优化压缩质量
- 依赖现有 `context-assembler.ts` / `memory-service.ts` / `message-service.ts` / `cli-orchestrator.ts`
- 模块五新增依赖：`@huggingface/transformers`（本地 embedding 模型）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 工具输出持久化策略 | (A) 全量 SQLite / (B) 只留摘要 / (C) 结构化摘要+MCP召回 / (D) Microcompact 带锚点占位符 | **D** | 三人一致：实现成本最低，解决核心痛点 80%。C 作为长期补充 |
| Microcompact 作用层 | (A) SQLite 读取后 / (B) context-assembler 输出阶段 / (C) prompt 拼装后 | **B** | 不污染 roomSnapshot，不改 SQLite，又能在 token 计算前省到 |
| SOP 书签格式 | (A) 自然语言段落 / (B) 结构化 JSON 字段 | **B** | 机器可读，防串台。德彪强制约束 |
| 向量存储 | (A) sqlite-vss / (B) better-sqlite3 暴力余弦 / (C) 外部 API embedding | **B** | sqlite-vss 不兼容 Windows；数据量不大暴力搜索够用；零外部依赖 |
| seal 后行为 | (A) 等用户消息 / (B) 自动续接+安全阀 | **B** | 解决"出门回来发现停了"的痛点，2 次上限防死循环 |
| 优化路径优先级 | (A) Microcompact+SOP先行 → 动态预算 → 渐进老化 / (B) 动态预算先行 | **一次全做** | 小孙明确要求"要做就一次做好" |
| 摘要 Fallback | (A) 只退 extractive / (B) Gemini → 当前 CLI → extractive | **B** | 多一层 LLM 摘要兜底，质量远好于纯 extractive |

## Implementation Constraints（铁律不可违反）

1. **数据神圣不可删**：Microcompact 只改注入视图，SQLite 原始记录不动
2. **进程自保**：embedding 生成异步，主流程不阻塞，失败静默降级
3. **配置不可变**：所有新阈值走代码常量，不改 `.env`
4. SOP 书签必须结构化，不能是自然语言
5. Timeline 是展示层产物，不是真相源
6. 最近一份失败证据（stderr / exit code / 路径）必须保留原文

## File Change List

| 文件 | 改动类型 | 涉及模块 |
|------|---------|---------|
| `packages/api/src/orchestrator/microcompact.ts` | **新建** | 一 |
| `packages/api/src/orchestrator/context-assembler.ts` | 改 | 一、二、四、五 |
| `packages/api/src/orchestrator/context-policy.ts` | 改 | 四 |
| `packages/api/src/services/memory-service.ts` | 改 | 二、六 |
| `packages/api/src/services/message-service.ts` | 改 | 三 |
| `packages/api/src/services/metrics-service.ts` | **新建** | 八 |
| `packages/api/src/runtime/cli-orchestrator.ts` | 改 | 七 |
| `packages/api/src/runtime/continuation-loop.ts` | 改 | 三 |
| `packages/api/src/db/repositories/session-repository.ts` | 改 | 二、八 |
| `packages/api/src/db/sqlite.ts` | 改 | 二、五、八 |
| `packages/shared/src/constants.ts` | 改 | 四 |
| `packages/ui/src/components/` | 改 | 九 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-13 | Kickoff — 三人协作讨论收敛（3 轮），方案确认，小孙拍板一次做完 |
| 2026-04-13 | 立项 — 聚合文件 + ROADMAP 索引 (`13abf70`) |
| 2026-04-13 | 实施计划 — `docs/plans/f007-context-compression-plan.md` (`7504f71`) |
| 2026-04-14 | 实现 — 9 模块 TDD 完成，91+ 测试全绿 (`b5d77fc`) |
| 2026-04-14 | Review R1 — 德彪 3 条 P1，全部修复 (`db5c079`) |
| 2026-04-14 | Review R2 — 德彪 2 条 P1 + 1 条 P2，全部修复 (`ece0a52`) |
| 2026-04-14 | Review R3 — 德彪放行，无新 bug |
| 2026-04-14 | Merge — 合入 dev 并推送远程 |
| 2026-04-14 | B012 Bugfix — SOP 书签阶段漂移：删除正则 phase 检测 + cycle completed 标记 + fillRatio 安全阀修正 (`a54cd24`, `72f1475`) |

## Links

- Discussion: 本次三人协作讨论（黄仁勋 × 范德彪 × 桂芬，Phase 1-2 共 3 轮）
- Reference: `reference-code/open-harness/`（Microcompact）、`reference-code/clowder-ai/`（SOP 书签 + F-BLOAT）、`reference-code/deer-flow/`（渐进式老化）
- Related: F004（前序：上下文记忆权威化）

## Evolution

- **Evolved from**: F004（上下文记忆权威化）
- **Blocks**: 无
- **Related**: F006（UI/UX 重塑，模块九 UX 层可能有交叉）
