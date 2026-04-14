---
id: B005
title: direct-turn 失忆 — nativeSessionId 被清后历史彻底丢失
status: fixed
related: F004
created: 2026-04-11
---

# B005 — direct-turn 失忆

**Related**: F004 上下文记忆权威化
**Created**: 2026-04-11

## 诊断胶囊（8 栏工作模板）

### 1. 现象

小孙新会话里直接 @ 黄仁勋，agent 完全不记得之前说过什么，像失忆。

### 2. 证据

- `packages/api/src/orchestrator/context-assembler.ts:155-177` `assembleDirectTurnPrompt` 只返回 `systemPrompt`（base identity + rolling summary），不注入任何真实消息历史
- `context-assembler.ts:111` `shouldInjectSelfHistory = policy.injectSelfHistory && !input.nativeSessionId` —— nativeSessionId 存在就跳过 self-history
- `packages/api/src/services/message-service.ts:904-955` 有 3 条路径会把 `nativeSessionId` 清成 null：
  - L904-907 空回 + session 未变
  - L917-921 classifyFailure 判 `shouldClearSession=true`
  - L935-945 `sealDecision.shouldSeal`
- `packages/api/src/runtime/failure-classifier.ts:132-138` `unknown` 兜底 → `shouldClearSession: true`，任何未识别错误都清
- `packages/api/src/services/memory-service.ts:102` rolling summary 要 >10 条 user 消息才生成，新会话前 10 轮完全无兜底
- commit 溯源：`ca87c9d` refactor(context) unified Context Policy 是真正引入该缺陷的 commit；`74d64e0` fix(B002) 把 context_exhausted 加入清 session 路径，放大问题

### 3. 假设

失忆 = "nativeSessionId 被清 + assembleDirectTurnPrompt 不注入真实历史 + rolling summary 兜底不够强" 三个条件叠加的必然结果。只要任一清 session 路径触发，后续所有 direct-turn 对话都会丢失之前的真实消息内容。

### 4. 诊断策略

Phase 1 已完成：代码静态分析 + commit 溯源 + 对照 reference-code 三份最佳实践（OpenHarness / clowder-ai / deer-flow）。

Phase 2 对照结论：三份实现的共同不变量是"**历史必须由服务端权威持有**"。deer-flow 用 LangGraph checkpointer，clowder-ai 用完整 context window + 真实消息注入，我们用"赌 CLI --resume + 稀薄 summary" —— 独一份错误。

### 5. 超时策略

不适用（非运行时 bug，无超时语义）。

### 6. 预警策略

修复后加以下测试作为回归预警：
- `context-assembler.test.ts` 失忆复现失败测试（F004/AC1）
- `failure-classifier.test.ts` unknown case 的 shouldClearSession 断言（F004/AC4）

### 7. 用户可见修正

无需紧急 hotfix —— 通过 F004 的实施一次性修好。修复后小孙视角：新建会话连续对话 10+ 轮，重启 API 后 agent 仍记得前面内容。

### 8. 验收

见 F004 AC1 / AC2 / AC8 —— 在 F004 完成时同步关闭本 bug。

## 五件套存档（Phase 4 修复完成后回填）

### 报告人

小孙，真实使用中反复观察到 agent 失忆。2026-04-11 明确上报。

### 复现步骤

自动化最小复现：`packages/api/src/orchestrator/context-assembler.test.ts` 的 `B005 regression — assembleDirectTurnPrompt injects roomSnapshot into content even with non-null nativeSessionId`。该测试构造 3 条含 "F004" / "reference-code" / "继续推进" 字样的 `roomSnapshot`，调用 `assembleDirectTurnPrompt` 并断言 `result.content` 包含这些历史片段。**当前代码**（ca87c9d 后）—— `result.content` 是 `undefined` 因为 direct-turn 签名只返回 systemPrompt 字符串。这就是失忆的最小体现。

### 根因分析

见 F004 `Why` 章节 + 本文件诊断胶囊 §2 证据链。

### 修复方案

见 F004 AC1-AC4。单点列出：

1. `assembleDirectTurnPrompt` 重构，接收 `AssembleDirectTurnInput` 对象（含 `roomSnapshot`），返回 `AssemblePromptResult`（`{systemPrompt, content}` 两段式），实现上 delegate 到 `assemblePrompt` + `POLICY_FULL`
2. 移除 `context-assembler.ts:111` 的 `!input.nativeSessionId` guard（`shouldInjectSelfHistory = policy.injectSelfHistory` 纯净版）
3. `failure-classifier.ts:132` `unknown` case `shouldClearSession: true → false` + userMessage 更新
4. `message-service.ts:904` 空回清 session 加 `exitCode !== 0 && exitCode !== null` 前置条件
5. `POLICY_FULL` 扩大历史预算：`sharedHistoryLimit 10→30`, `selfHistoryLimit 5→15`, `maxContentLength 500→2000`；`POLICY_INDEPENDENT` 同步扩 selfHistoryLimit + maxContentLength
6. `SEAL_THRESHOLDS_BY_PROVIDER.gemini` `0.55/0.65 → 0.70/0.80`（1M 窗口过度激进，减少 session 被无谓 seal 的频率）
7. `message-service.ts` direct-turn 调用点改为先 `captureSnapshot` 再把 `assembledPrompt.content` 作为 `effectiveUserMessage` 传给 `runContinuationLoop`（不是只用 `systemPrompt`）

### 验证方式

**自动化**（`npx tsx --test`）：
- `context-assembler.test.ts` 的 B005 regression 测试绿
- `failure-classifier.test.ts` 的 "unknown failures no longer clear session (F004/AC4)" 绿 + 既有 "falls through to unknown" 断言翻转后绿
- `context-seal.test.ts` 三条 gemini 阈值测试按新值更新后绿
- `base-runtime.test.ts` 原 fast-fail 测试不变（因默认 threshold=1）
- 合计：context-assembler / context-snapshot / base-runtime / failure-classifier / context-seal / message-service / memory-service 七个文件 75/75 绿

**手动**（见 F004/AC8）：
- 场景 1：连续 10 轮对话 → 重启 API → 第 11 轮黄仁勋记得前面
- 场景 3：人为触发 context seal → 下一轮不失忆
