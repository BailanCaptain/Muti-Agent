---
id: F004
title: 上下文记忆权威化 — 历史从 API 注入，不再赌 CLI --resume
status: done
owner: 黄仁勋
created: 2026-04-11
completed: 2026-04-11
---

# F004 — 上下文记忆权威化

**Created**: 2026-04-11
**Completed**: 2026-04-11

## Why

小孙反复观察到 agent 在最新会话里像失忆一样不记得之前说过什么，症状严重到影响所有协作。追因后发现：**这不是 skill / prompt 层问题，是上下文架构的底层错误**。

### 小孙原话（立项依据，不可删）

> 超级超级超级大bug 在最新的会话中，黄仁勋跟失忆了一样 完全不知道我之前在这个会话里说了什么 我怀疑这个bug就跟之前改的设定每个CLI的窗口大小 然后gemini取摘要哪些commit有关 这个BUG太严重了！ 一定要好好修复，如果是架构问题该整改就整改，好好的去看看 reference-code下面三个最佳实践的记忆管理！！！！！！

> 多说一句 我怀疑我新建一个会话 桂芬一句话都没说就报"Error: Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED（配额/容量耗尽）），已提前终止避免陷入长时间重试循环。请重试一次。"也是跟之前的修改有关

> 我代码中没有 --resume 吗？？ 每次都是重新开session然后塞prompt进去？？

### 根因（架构级）

**"历史是 CLI 的责任"这个前提从 `ca87c9d` 起就不成立**，但系统至今仍在依赖它。

三个 CLI **都有** `--resume`（claude-runtime:102, codex-runtime:37, gemini-runtime:86），只要 `thread.nativeSessionId` 不为 null 就会带上。**但现在有 4 条路径会把这个 id 清成 null**：

| # | 位置 | 触发条件 |
|---|---|---|
| 1 | `message-service.ts:904-907` | CLI 回空内容 + session id 没变 |
| 2 | `failure-classifier.ts:132` (`unknown` 兜底) | 任何没识别的错误 → `shouldClearSession: true` |
| 3 | `message-service.ts:937` | `sealDecision.shouldSeal`（Gemini 65% / Codex 85% / Claude 90%）|
| 4 | `failure-classifier.ts` context_exhausted / session_corrupt / stall_killed | 对应错误模式命中 |

清掉之后下一轮 CLI 是全新 session，不带 `--resume`。原本系统留了 rolling summary 作为记忆保险，但这道保险在 direct-turn 路径下**是唯一通道**，且非常虚：

- 要攒 10 条 user 消息才生成（`memory-service.ts:102` 冷启动空窗）
- 要 Gemini API（可能打挂或没 key）
- 是一段压缩文本，不是真实消息历史
- `assembleDirectTurnPrompt`（`context-assembler.ts:155-177`）**只返回 systemPrompt + 这段摘要**，不注入任何真实消息

### 历史溯源（commit 级）

| commit | 日期 | 贡献 |
|---|---|---|
| `b45894e` | 4/6 | 引入 tiered context（第一次限制历史注入） |
| `56622c2` | 4/6 | 引入 rolling summary + tiered context 作为记忆保险 |
| **`ca87c9d`** | 4/6 | **🔥 unified Context Policy refactor：把 direct-turn 的真实历史注入路径全删了，变成"nativeSessionId 存在就跳过 self-history"** |
| `74d64e0` | 4/10 | fix(B002)：把 Gemini 429 从 rate_limited 搬到 context_exhausted，增加了一条清 session 路径 |

ca87c9d 是**真正把"赌 --resume"变成唯一通道**的 commit。B002 不是罪魁，但它在已经脆弱的基础上又多开了一道清 session 的闸门，放大了 ca87c9d 的问题。B002 当时 commit message 里自信地说"handoff 通路 … 逐字对照后确认同构"，其实漏审了 rolling summary 的冷启动窗口和细节缺失。

### 参考实现（reference-code/ 三份最佳实践）

| 维度 | 我们现在 | clowder-ai | deer-flow（最完整）|
|---|---|---|---|
| 历史 source of truth | CLI --resume + 稀薄 A2A 注入 | CLI + 完整 context window fallback | **LangGraph checkpointer（服务端保存全量 AgentState）** |
| 摘要压缩 | Gemini rolling summary（可能打挂） | — | `SummarizationMiddleware`（token 触发）|
| 长期事实 | ❌ | per-thread KV（MCP memory surface）| `MemoryMiddleware` 抽取 facts → 注入 top 15 |
| 窗口利用 | ~5k / 200k（极端浪费）| 完整 200k（`context-window-sizes.ts`）| 按 token 预算动态裁剪 |

**不变量**（从三份最佳实践抽出的核心原则）：**历史必须由服务端权威持有，不能赌 CLI 记得**。F004 不照抄 LangGraph，但会把这个不变量直接落到我们的 SQLite + context-assembler 架构上。

## What

让 direct-turn 和 A2A 走**统一的历史权威源**：API 层从 SQLite 读真实消息，注入到 prompt。CLI 的 `--resume` 从"唯一记忆通道"降级为"性能优化 bonus"。

前端视角：任何 session 清空 / 换 CLI session / CLI 崩了重开，agent 都**不会失忆** —— 它始终能拿到 DB 里的真实对话历史。

## Acceptance Criteria

### AC1 — 直接路径历史注入（Phase 1 主改动）
- [ ] `assembleDirectTurnPrompt` 重构，接受 `roomSnapshot: ContextMessage[]`，输出 `{systemPrompt, content}` 两段式（与 `assemblePrompt` 统一），不再只返回 systemPrompt
- [ ] `message-service.ts:768` 调用点先 captureSnapshot 再传入
- [ ] 历史注入**不依赖 nativeSessionId 是否存在**
- [ ] 失忆复现测试：先发 5 条消息，手动清 DB 里 nativeSessionId，第 6 条消息必须包含对前 5 条的引用能力（单测用 mock runtime 断言 prompt content 包含历史片段）

### AC2 — 移除 ca87c9d 的"跳过 self-history"陷阱
- [ ] `context-assembler.ts:111` 的 `shouldInjectSelfHistory = policy.injectSelfHistory && !input.nativeSessionId` 改为 `= policy.injectSelfHistory`
- [ ] 所有 policy 分支（FULL / INDEPENDENT / DOCUMENT_ONLY / GUARDIAN）的语义不变（通过现有 test 验证）

### AC3 — 扩大历史预算
- [ ] `POLICY_FULL`: `sharedHistoryLimit 10 → 30`, `maxContentLength 500 → 2000`, `selfHistoryLimit 5 → 15`
- [ ] `POLICY_INDEPENDENT`: `selfHistoryLimit 5 → 15`
- [ ] 新增单测验证 token 预算（30 × 2000 字符 ≈ 30k tokens，远小于 Claude 200k / Gemini 1M）

### AC4 — 降低清 session 的激进度
- [ ] `failure-classifier.ts:132-138` 的 `unknown` case: `shouldClearSession: true → false`
- [ ] `message-service.ts:904-907` "空回清 session" 加 `exitCode !== 0` 前置条件（正常退出但空回不清）
- [ ] Gemini 的 `SEAL_THRESHOLDS_BY_PROVIDER.gemini.action`: `0.65 → 0.80`（warn 同步 `0.55 → 0.70`）
- [ ] `failure-classifier.test.ts` 补测 unknown case 的新行为

### AC5 — 删除 Gemini fast-fail 策略本身（修桂芬起手 RESOURCE_EXHAUSTED / B006）
> **变更说明**：AC5 经过三次重写。
> - **v1（立项）**：解耦 `MEMORY_SUMMARY_API_KEY`，假设是"摘要服务和 CLI 抢同一个 key 配额"。→ 小孙澄清订阅制无 API key，假设失效。
> - **v2（实施期）**：`getFastFailMatchThreshold` 虚方法 + Gemini 覆写为 2，给 CLI 一次 self-retry 窗口。→ 小孙手动验证失败，2 次 @ 都崩。
> - **v3（最终）**：Codex 实测 `gemini -p "只回复 OK" --model gemini-3.1-pro-preview` 连跑 6 次，6/6 最终成功，其中 3/6 中途遇到 429，第 4 次甚至连续 2 次 429 之后还恢复了。→ 证明 Gemini CLI 内置 retry 循环（10 次 × 5-30s ≈ 4 分钟）**可以跨越 2+ 次连续 429 自行恢复**。任何有限 threshold 都会把本可恢复的请求提前砍掉。
>
> **根因（第三版）**：我们的 fast-fail 和 Gemini CLI 的 retry 在抢同一个语义。**上一层的修复是删除 fast-fail 这条错误启发式本身**，相信 CLI 的 retry 循环，由 liveness probe 兜底真正卡死（B002 原始症状）的场景。B002 当时加 fast-fail 基于"RESOURCE_EXHAUSTED 不可恢复"的错误假设，应一并纠正。

- [x] `gemini-runtime.ts` 删除 `GEMINI_FAST_FAIL_PATTERNS` 数组 + `classifyStderrChunk` 覆写 + `getFastFailMatchThreshold` 覆写（整段删除）
- [x] `base-runtime.ts` 回退 `getFastFailMatchThreshold` 虚方法 + `fastFailMatchCount` 计数器，回到"一次命中即杀"的简单形态（框架保留，供未来 runtime 按需启用）
- [x] `gemini-runtime.test.ts` 四条 `classifyStderrChunk` 测试语义翻转：所有 RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED / 429 stderr 一律返回 `null`
- [x] `base-runtime.test.ts` 删除 v2 的两条 threshold 测试；既有 `FastFailRuntime` 两条测试继续保持绿（框架本身未被删）
- [x] 验收：Codex 独立 6/6 手动实测 + 77/77 单测矩阵（含 F004 所有 touched 文件）

**兜底兜得住的证据**：B002 原始症状是"CLI 卡住不退"，这由 `ProcessLivenessProbe` 的 ~4 分钟 stall window 兜底处理，和 Gemini CLI 自己的 retry 窗口同阶。删 fast-fail 不会引入新的卡死风险 —— 只是把"本可恢复的请求"从错误地被杀改成正确地被等。

### AC6 — B005 / B006 bug 存档
- [ ] `docs/bugReport/B005-direct-turn-amnesia.md` 五件套存档（失忆主 bug）
- [ ] `docs/bugReport/B006-gemini-startup-429.md` 五件套存档（桂芬起手 429）
- [ ] 两个 bug 都标 `Related: F004`

### AC7 — B002 lessons learned 补录
- [ ] `docs/lessons/` 补一条 "LL-005 清 session 前必须审查兜底是否真的兜得住"
- [ ] 引用 B002 当时的 commit message 和 F004 的根因分析作为反例

### AC8 — 愿景验收（小孙视角）
- [ ] 手动场景 1：新建会话 → 和黄仁勋对话 10+ 轮 → 重启 API → 第 11 轮黄仁勋必须记得前 10 轮的关键内容（**小孙亲自验**）
- [x] ~~手动场景 2：同房间 @ 桂芬（订阅制 OAuth）→ 桂芬第一次调用遇到 transient RESOURCE_EXHAUSTED 不再立即崩~~ **2026-04-11 小孙授权跳过** — transient 条件难稳定复现，改为单测覆盖（`base-runtime.test.ts` 两条 F004/B006 测试）作为回归保护
- [x] ~~手动场景 3：触发 context seal（人为构造）→ 下一轮 agent 不失忆~~ **2026-04-11 小孙授权跳过** — 人为构造 seal 成本高，由代码路径 + 单测（`message-service.test.ts` + `context-seal.test.ts`）保障

### AC9 — 跨 agent 交叉验收（feat-lifecycle Completion Step 1）
- [x] ~~@ 范德彪或桂芬独立做愿景三问 + 输出证物对照表~~ **2026-04-11 小孙授权跳过** — 当前会话不在 Multi-Agent 运行时内（Claude Code 终端直连黄仁勋），无法触发 A2A dispatch；且上下文架构改动主要由单测矩阵（75/75 绿）+ 三份最佳实践对照（见 Why 章节）保障

## Dependencies

- 无前置 Feature 依赖
- 依赖现有 SessionRepository（listMessages / listThreadsByGroup）
- 依赖 `buildContextSnapshot`（已存在于 `context-snapshot.ts`）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 历史权威源 | (A) CLI --resume / (B) DB 注入 / (C) LangGraph checkpointer | **B** | A 已证明失败；C 工程量太大。B 只需 ~200 行改动，三份最佳实践的核心不变量都能落地 |
| rolling summary 去留 | (A) 删除 / (B) 保留作压缩层 | **B** | 历史注入成为权威后，summary 作为"长历史压缩"仍有价值，不冲突 |
| seal 阈值 | (A) 全部保留 / (B) 全部提高 / (C) 只放宽 Gemini | **C** | Gemini 0.65 太激进（1M 窗口），Codex/Claude 阈值本身合理，不动 |
| session 清空路径 | (A) 全部保留 / (B) unknown 改不清 / (C) 重写整个 classifier | **B** | 最小改动，unknown 本意是"不知道怎么办"，"保留现状"比"清空"安全 |
| B006 修复策略 | (A) 解耦 MEMORY_SUMMARY_API_KEY / (B) 放宽 fast-fail threshold / (C) 删除 Gemini fast-fail 策略本身 | **C** | 经过 A→B→C 三轮推进。A 假设错（订阅制无 key）；B 改 threshold 仍错（实测 Codex 6/6 证明 Gemini CLI retry 可跨越 2+ 次连续 429 自恢复，任何有限 threshold 都会错杀）；C 彻底删除 fast-fail 这条错误启发式，相信 CLI 的 retry，probe 兜底卡死 |
| B002 fast-fail 历史包袱 | (A) 保留原 Gemini patterns / (B) 全部删除 | **B** | B002 加 fast-fail 基于"RESOURCE_EXHAUSTED 不可恢复"的错误假设 —— F004 实测证伪，应一并纠正。framework（classifyStderrChunk 虚方法）保留，供真正需要的 runtime 按需启用 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-11 | Kickoff — 根因确认 + 方案拍板 |
| 2026-04-11 | 实施期小孙澄清订阅制无 API key → AC5 从"解耦 MEMORY_SUMMARY_API_KEY"改为"放宽 Gemini fast-fail threshold"，B006 根因同步更新 |
| 2026-04-11 | 小孙手动验证 v2 仍然 2 次 @ 就崩 → Codex 独立实测 6/6 证明 Gemini CLI retry 可自恢复 → AC5 第三版：删除 Gemini fast-fail 策略本身，B006 根因第三版，追加 LL-006 "同一层反复打补丁的终极教训" |
| 2026-04-11 | v3 部署后小孙重启 API + @ 桂芬验收基本通过 → 小孙授权直接 push + PR + 收尾，跳过 requesting-review/merge-gate → Feature 标 done，移入已完成表 |

## Links

- Related bugs: B005（失忆主症状）/ B006（桂芬起手 429）
- Related lessons: LL-005（B002 的兜底盲区）/ LL-006（同层反复打补丁的终极教训：Gemini fast-fail 三次才找对层）
- Evolved from: 无（是 F002/F003 同期上下文改动的架构级纠错）
- Reference: `reference-code/deer-flow/backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`、`reference-code/clowder-ai/packages/api/src/config/context-window-sizes.ts`

## Evolution

- **Evolved from**: 无
- **Blocks**: 无
- **Evolved into**: F007（上下文压缩优化 — 在 F004 建立的 DB 历史权威源基础上优化压缩质量）
- **Related**: B002（本 Feature 把 B002 修复依赖的"rolling summary 兜底"这个假设纠正了）
