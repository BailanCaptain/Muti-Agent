# F037 Evidence-Based Editorial Gate Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 社区只发布 AI 研究、工程、发布和实质讨论；推理突出但不独占，并以证据化双审替代语义正则终态裁判，保持现有日报呈现与榜单行为不变。
**Acceptance Criteria:** F037 AC3（推理仅指大模型推理/部署/服务，突出但不独占；无合格推理可为空；finance 不得进推理）、AC11（结构化模型链全败则宁缺勿发）、B032 AC16-AC20（审核/摘要分离、双审+争议裁决、证据锚定、删除语义正则 veto、呈现零回归）。
**Architecture:** `EditorialDecider` 正常由两个不同 Claude target 独立审核 AI/community/podcast，固定 Codex 只裁关键冲突；若全部 Claude target 都是结构化 runner 失败，则固定 Codex 以 fresh context 做 clean-room A/B、分歧才 C，并明示 `degraded_same_target`。代码从类型化 basis 派生决定；`DigestComposer` 只接收 final publish 原文快照与冻结 facets。模型负责开放语义，代码只负责证据 provenance、票合并与发布不变量。
**Tech Stack:** TypeScript、Node test runner、现有 Claude/Codex CLI runners、SHA-256、DigestPublicationV2。

---

## Finish line / Non-goals

终态 B：新生产摘要不再输出 `editorialAssessments/communityDropIds`；每个送审项有带 target provenance 的最终 decision；composer prompt 中不存在 rejected/abstain 原文；publication 不再用 finance/help/reaction/action 关键词改判。

不做：邮件两行改版、视觉 restyle、栏目/“开源榜单”改名、GitHub 准入/排序/跨日状态变化、模型设置新增字段、单腿 timeout 改值、`.env`/runtime 配置修改、真实补发。

### Task 1: RED — 锁定结构化 target runner 与预算

**Files:**
- Modify: `packages/api/src/services/daily-digest/model-runner.test.ts`
- Modify: `packages/api/src/services/scheduler/scheduler-config.test.ts`

**Step 1: Write the failing tests**

- runner 暴露去重后的 target 列表和 `runTargetPrompt(index, prompt, opts)`；只运行指定 target，并继续应用 Claude 6h/Codex 12h 下限、abort 和错误脱敏。
- `runValidatedStage` 把 parser 放在 target 循环内部：primary provider 成功但结构 invalid 时，composer 调 fallback target，而不是重新从 primary 开始；每个 target 每轮最多一次批调用，第三 target 后 fail-closed。
- Claude A/B + Codex pass 1/2/3（降级审核最坏 48h）+ composer 三目标（24h）的全链最坏账为 `778350s < 1209600s`；旧 `MAX_SUMMARIZE_ATTEMPTS × modelChain` 账式必须失败。

**Step 2: Run RED**

Run: `pnpm exec tsx --test packages/api/src/services/daily-digest/model-runner.test.ts packages/api/src/services/scheduler/scheduler-config.test.ts`

Expected: `runTargetPrompt` 不存在、旧最坏账仍为 864750s。

**Step 3: Minimal GREEN**

在 `model-runner.ts` 增加结构化 target-aware 接口，复用现有 chain/timeout/error 分类；`runPrompt` 的既有顺序 fallback 行为保持不变。更新 scheduler 账式与注释，不改三个 14d 配置值。

**Step 4: Verify GREEN**

Run 同 Step 2；预期全部 PASS。

### Task 2: RED — 决策 schema、原文证据和票合并

**Files:**
- Create: `packages/api/src/services/daily-digest/editorial-decider.ts`
- Create: `packages/api/src/services/daily-digest/editorial-decider.test.ts`
- Modify: `packages/api/src/services/daily-digest/types.ts`

**Step 1: Write the failing tests**

先写测试引用尚不存在的终态 API：

```ts
parseEditorialVotes(text, promptItems, reviewerTarget)
mergeEditorialVotes({ primary, fallback, adjudicator }, promptItems)
buildEditorialDecisionSet(promptItems, merged)
```

覆盖：

- 每项 `basis` 由闭集枚举映射为 publish/reject/abstain 与 contentKind/rejectReason。
- evidence 限 1-3 条、字段仅 title/snippet、trim 后 quote 为 1-160 字符且在同一送模快照中 NFC+空白规范化后可定位；单票 `JSON.stringify` 不超过 1024 字符；跨 ID、改写、生成摘要证据无效。
- community/podcast publish 只接受 research/engineering/release/technical discussion basis；industry/finance 票不能发布到社区。
- inference 必须有 `inference_technical` evidence；finance/inference 互斥。
- 两个不同 target 的关键票一致才定案；准入、inference、technical-vs-finance/industry 冲突进入 Codex；仍无两票一致则 abstain。
- 正常模式相同 provider/model/effort 不得算两票；只有全部 Claude target 均为结构化 runner failure 时，两个 fresh Codex slot 才可在 `degraded_same_target` 内按相关采样计票，且必须如实落档。
- 单条坏记录只使该 ID 未决，不丢弃同批有效票。
- `inputHash/policyVersion/reviewerTarget/reviewerSlot/reviewMode` 由服务端生成或注入；模型原始响应不含这些字段，同名注入字段会被忽略，不能伪造。补最大 88 候选输出预算与截断回归。
- consumer 不信任类型断言：publication/job 用唯一快照构造器重算 hash，重验固定 schema/policy、证据与 slot，再由原 votes 重建 decisions；畸形集合不得发布、不得抛未处理异常、不得回退 legacy。

**Step 2: Run RED**

Run: `pnpm exec tsx --test packages/api/src/services/daily-digest/editorial-decider.test.ts`

Expected: module/API 不存在。

**Step 3: Minimal GREEN**

实现类型化 basis、evidence validator、vote merger 和 `EditorialDecisionSet`；confidence 仅作遥测，不参与准入。

**Step 4: Verify GREEN**

Run 同 Step 2；预期全部 PASS。

### Task 3: RED — 真实正反例与独立审核调用

**Files:**
- Modify: `packages/api/src/services/daily-digest/editorial-decider.test.ts`
- Modify: `packages/api/src/services/daily-digest/summarizer.test.ts`

**Step 1: Add production-shaped fixtures**

用 B032 矩阵写 7 个正例和 7 个反例；至少包含真实 Sakana/ChatGPT Sites/CUDA/vLLM/GPT/相亲推荐/融资文本。

调用测试必须证明：

- Claude A/B 收到互不含对方判断的原始快照；B 固定审核全部 AI/community/podcast，而不只是 A 判低 confidence 的条目；
- 正常无冲突时调用数为 2；Codex pass 1 只收冲突/缺票 ID。
- 两个 Claude 都是 runner failure 时，Codex pass 1/2 接收同一冻结原文但 fresh context、互不看答案；pass 3 只收两票分歧/缺票 ID。
- Codex pass 1 同时承担正常裁决与降级 A，不得再额外调用“普通 Codex”；全部争议 ID 每 slot 合并为一次批调用，Decider 总调用上限 5，禁止逐 ID/外层重试。
- `aborted` 立即停链；坏 JSON、证据无效、语义分歧不得伪装成 Claude unavailable。
- 正常模式配置 target 重复时不冒充独立票；降级同 target 票必须标记不同 slot 与 `degraded_same_target`。

**Step 2: Run RED**

Run: `pnpm exec tsx --test packages/api/src/services/daily-digest/editorial-decider.test.ts packages/api/src/services/daily-digest/summarizer.test.ts`

Expected: 当前单响应 summarizer 无法满足审核调用与 fixture 合同。

**Step 3: Minimal GREEN**

新增审核 prompt（只输出 votes，不写摘要/选稿），通过 `runTargetPrompt` 执行 A/B/C 并合并；所有最终 abstain 归档但不发布。

**Step 4: Verify GREEN**

Run 同 Step 2；预期全部 PASS。

### Task 4: RED/GREEN — Composer 只消费 publish 集

**Files:**
- Modify: `packages/api/src/services/daily-digest/summarizer.ts`
- Modify: `packages/api/src/services/daily-digest/summarizer.test.ts`
- Modify: `packages/api/src/services/daily-digest/types.ts`

**Step 1: Write RED**

- composer prompt schema只含 overview/sections/picks/briefs，不含 `editorialAssessments/communityDropIds`。
- 输入必须是 `{id, category, source, title, snippet, facets}`，且只含 final publish ID；精确断言 rejected ChatGPT/help/reaction 标题和 snippet 不在 prompt。
- composer 引用幽灵/rejected ID、改变 category、或遗漏有双侧 eligible 时的 inference/非 inference 精选均使该 target invalid 并降级下一 target。
- 所有 target 无有效 compose 时返回 null，job 宁缺勿发。

**Step 2: Run RED**

Run: `pnpm exec tsx --test packages/api/src/services/daily-digest/summarizer.test.ts`

Expected: 当前 combined prompt 含审核字段且把 rejected 原文一起送入。

**Step 3: Minimal GREEN**

把 `createDigestSummarizer.summarize` 改为 `decide → compose → deepRead`；删除四次外层盲重试，两个阶段分别按 target 至多一次。返回 `DigestSummary.editorialDecisionSet`，旧 `editorialAssessments` 仅保留只读兼容类型。

**Step 4: Verify GREEN**

Run 同 Step 2；预期全部 PASS。

### Task 5: RED/GREEN — publication 切换单一审核真相源

**Files:**
- Modify: `packages/api/src/services/daily-digest/editorial-policy.ts`
- Modify: `packages/api/src/services/daily-digest/editorial-policy.test.ts`
- Modify: `packages/api/src/services/daily-digest/publication.ts`
- Modify: `packages/api/src/services/daily-digest/publication.test.ts`
- Modify: `packages/api/src/services/daily-digest/relevance-filter.ts`
- Modify: `packages/api/src/services/daily-digest/relevance-filter.test.ts`
- Modify: `packages/api/src/services/daily-digest/daily-digest-job.ts`
- Modify: `packages/api/src/services/daily-digest/daily-digest-job.test.ts`

**Step 1: Write RED**

- 新 decision set 存在时 publication 只从它派生 audit，忽略冲突的 legacy assessment/communityDropIds。
- Sakana publish research；finance 条目可留 AI 行业但 displayTag 不得推理；CUDA/vLLM/推荐模型正例发布，个人/赞叹/八卦反例拒绝。
- job 不再在送审前用 community 性质词表删除候选。
- `FINANCE_RE/HELP_RE/COMPLAINT_RE/GOSSIP_RE` 与 `hasSubstantiveCommunitySource` 不得再改写 final decision。
- 高召回 inference 候选若最终 abstain，job 返回 failed_summarize + 告警；全部明确 rejected 则允许推理为空。

**Step 2: Run RED**

Run: `pnpm exec tsx --test packages/api/src/services/daily-digest/editorial-policy.test.ts packages/api/src/services/daily-digest/publication.test.ts packages/api/src/services/daily-digest/relevance-filter.test.ts packages/api/src/services/daily-digest/daily-digest-job.test.ts`

Expected: 旧语义 regex 改判和 job 预删导致失败。

**Step 3: Minimal GREEN**

删除社区/finance/substantive 语义正则终态门与 `communityDropIds` 新路径；保留政治/未成年人安全、candidate selection 和结构不变量。旧 archive adapter 仅在 decision set 缺失时读取 legacy assessments。

**Step 4: Verify GREEN**

Run 同 Step 2；预期全部 PASS。

### Task 6: Archive v2 compatibility and historical replay

**Files:**
- Modify: `components/digest/digest-model.test.ts`
- Create: `.agents/acceptance/F037/2026-07-14-b032-evidence-editorial/` evidence only（不进 git）

**Step 1: Compatibility tests**

锁定外层/publication `schemaVersion: 2`；测试 legacy 无 decision set 的 v2 仍可读、新 B032 v2 可读，禁止本变更写 schemaVersion 3。

**Step 2: Read-only replay**

读取 2026-07-13 与 2026-07-14 的 `items.jsonl/summary.json`，用 mock/fixture reviewer 回放最终链；不得修改原归档、outbound ledger 或发信。

记录：候选数、publish/reject/abstain、推理/非推理数量、Sakana/ChatGPT Sites 判定、composer 输入 ID 与最终 publication ID。

### Task 7: Documentation, gates and review

**Files:**
- Complete: `docs/bugReport/B032-digest-semantic-regex-oscillation.md`
- Update: `docs/features/F037-daily-news-digest.md`
- Update: `docs/lessons/lessons-learned.md`
- Update: `docs/evolution-proposals/EP-002-evidence-based-editorial-gate.md`

**Step 1: Targeted and full verification**

- targeted B032 tests
- `pnpm --filter @multi-agent/api test`
- component tests
- `pnpm typecheck`
- `pnpm lint`
- `pnpm check:docs`
- `pnpm build`
- `git diff --check`

**Step 2: Quality pipeline**

按 `quality-gate → acceptance-guardian → requesting-review` 执行；reviewer 必须看到双审 target provenance、真实 replay、预算关系与所有 non-goals。P1/P2 按 receiving-review VERIFY + RED→GREEN 处理。

**Step 3: External action lock**

review 未放行前不真实补发、不改 runtime/.env/MCP 配置、不提交合并；补发需小孙再次明确要求。
