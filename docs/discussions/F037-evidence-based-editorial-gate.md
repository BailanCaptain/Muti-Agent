# F037 证据化编辑判定收敛（B032）

**日期：** 2026-07-14

**参与：** 小孙、范德彪；两名独立架构/反方审计 agent

**结论：** 小孙拍板停止“语义正则补丁”路线；编辑审核与摘要写作拆成两阶段。正常模式下 AI/社区/播客由两个不同 Claude target 独立审核、固定 Codex 只裁决关键分歧；Claude provider 当前不可用时，必须进入明确标记的 `degraded_same_target`，由固定 Codex 做互不看答案的 clean-room A/B 审核，分歧才做 C。邮件格局、文案、开源榜单、GitHub 排名和现有超时值不变。

## 1. 小孙原话与问题定义

> “结构规则是死代码吗？你准备怎么处理，又去改规则吗？”

> “可以，我也觉得正则补丁路线不行！”

实际问题不是少了哪个词，而是开放语言被闭集正则裁决：

- `share our latest research` 被 `shares?` 当成金融，Sakana AI 研究误杀；
- 为保留 CUDA 排障加入 `debug/batching` 后，纯赞叹又可借同词穿透；
- 同一模型响应同时输出审核、选稿和摘要，曾出现判 `self_promo` 却又引用同一 ID。

## 2. 终态数据流

```text
高召回候选（新鲜度 / shown / 源轮转 / 安全红线）
  → EditorialDecider
      Claude primary：全量审核
      Claude fallback：独立审核 AI / community / podcast + primary 未决 hot
      Codex gpt-5.6-sol/high：正常模式只裁决关键冲突或缺票；
        两个 Claude 均为 provider/transport/timeout 失败时，执行 clean-room A/B/C 降级审核
  → 服务端合并为 EditorialDecisionSet（原文证据 + target provenance）
  → DigestComposer（输入中只有 final publish 条目及冻结 facets）
  → 引用 / 推理双侧 / 邮件预算不变量
  → 现有 DigestPublicationV2 → renderer / mail / web / archive / shown
```

### 职责边界

- **模型负责开放语义**：研究、工程、发布、技术讨论、产业、金融、个人求助、抱怨、八卦、纯反应等。
- **代码负责闭集不变量**：ID、枚举、证据来自同一原文、审核票来源、决定合并、引用只落在 publish 集、finance/inference 互斥、最终推理/非推理覆盖。
- **摘要不能重新审核**：composer 看不到 rejected/abstain 的标题和正文，也不能输出 contentKind/topicTags。
- **evidence 只证明 provenance**：逐字证据能证明“模型依据来自原文”，不能数学证明语义判断正确；语义可靠性由独立双审、冲突裁决、版本化 policy 和真实反例回放共同承担。

## 3. 终态 schema

模型不自由输出 `verdict/contentKind` 组合，而是输出类型化 `basis`；代码从 basis 派生准入、内容类型和拒绝原因，消除自相矛盾。

```ts
type EditorialBasis =
  | "research_result"
  | "engineering_work"
  | "product_release"
  | "technical_discussion"
  | "ai_industry_event"
  | "finance_event"
  | "personal_help"
  | "complaint"
  | "gossip"
  | "self_promo_only"
  | "reaction_only"
  | "off_topic"
  | "unsafe"
  | "politics"
  | "insufficient_context"
  | "mixed_signals"

interface EditorialEvidence {
  field: "title" | "snippet"
  quote: string // 每票 1-3 条；trim 后 1-160 字符，必须来自同一送模快照
  supports: "ai_relevance" | "substantive_fact" | "inference_technical" | "finance_context" | "disqualifier"
}

interface EditorialReviewVote {
  itemId: string
  basis: EditorialBasis
  topicTags: EditorialTopicTag[]
  organizationTags: string[]
  ecosystemTags: Array<"open_source" | "closed_source">
  regionTags: Array<"cn" | "global">
  evidence: EditorialEvidence[]
  // 只由 target-aware executor 注入；模型响应中没有也不能覆盖此字段
  reviewerTarget: { provider: "claude" | "codex"; model: string; effort?: string }
  reviewerSlot: "review_a" | "review_b" | "codex_pass_1" | "codex_pass_2" | "codex_pass_3"
}

interface EditorialDecisionSet {
  schemaVersion: 1
  policyVersion: "F037-B032-v1"
  inputHash: string
  reviewMode: "multi_target" | "degraded_same_target"
  decisions: EditorialDecision[] // 服务端按票派生 publish/reject/abstain
}
```

模型原始响应只含 `itemId/basis/tags/evidence`，单票 `JSON.stringify` 上限 1024 字符；
`reviewerTarget`、`reviewerSlot`、`reviewMode`、`policyVersion` 和 `inputHash` 全部由服务端注入。即使提示注入让模型输出同名字段，
parser 也会忽略它，不能伪造第二位审核者。最大 88 条候选要有输出预算与截断回归测试。

### 合并规则

1. 正常模式下 AI/community/podcast 至少需要两个不同 target 的有效票；配置的两个 Claude 默认分别提供 A/B 票。
2. 两票在准入、是否 inference、或 `technical vs industry/finance` 上一致，直接形成决定；两票都拒绝时不因拒绝理由文字不同调用 Codex。
3. 关键冲突、缺票或结构/证据无效时，只把对应 ID 合并成**一次批调用**送固定 Codex 裁决；仍无法形成两票一致则 `abstain`，永不发布。
4. hot 允许单审；primary 单条无效时按 fallback → Codex 补该 ID，不重跑已有效条目。
5. `abstain` 是业务终态；正常多 target 模式下，高召回 inference 候选仍 abstain 时阻止发送并告警。`degraded_same_target` 下为满足 Claude 故障可用性，只摘除未决条目、记录 `inference_review_unresolved` 并告警，不阻断其余非空日报；任何模式都不能把“未审清”伪装成“今天没有推理进展”。
6. 如果两个 Claude 配成同一 target，不能冒充两份独立意见；使用剩余不同 target，无法形成一致票则 abstain。
7. 只有 executor 的结构化 attempt 状态证明**全部可用 Claude target 都是 runner 失败**（provider unavailable / transport / timeout；`aborted` 立即停链）时，才可进入 `degraded_same_target`；控制流不得解析宽泛错误字符串。Claude 已返回但语义分歧、坏 JSON、证据无效都不得触发这一降级。
8. `degraded_same_target` 中 Codex A/B 使用全新无共享会话，只看同一冻结原文和 policy，不看彼此答案；A/B 分歧才执行 C，按关键轴两票等价收敛。归档必须如实记录同一 target、不同 slot 与降级模式，不能宣称“双模型审核”。
9. Decider 固定上限为 Claude A/B + Codex pass 1/2/3 共 5 次：Codex pass 1 同时承担正常争议裁决与降级 A，不能先跑一个“普通 Codex”再额外跑 A/B/C；pass 2 只补全部 Claude runner 失败的关键项，pass 3 只补这两票的分歧/缺票。每个 reviewer slot 每轮最多一次批调用，禁止重启 primary、逐 ID 串行重跑或外层重试。
10. `EditorialDecisionSet` 是跨阶段授权凭证而非可信 TypeScript 对象。job/publication 消费前必须以同一输入快照重算 `inputHash`，校验固定 schema/policy、票的 target/slot/证据，并用服务端合并器重建决定；畸形、过期或伪造集合一律 fail-closed，且不得回退旧语义规则。

## 4. 保留与删除

### 保留

- 新鲜度、shown 去重、源轮转和 `isInferenceReviewCandidate` 高召回送审保护；它们不产生最终发布资格。
- 政治/未成年人安全的既有保守硬红线（本轮不扩写词表，也不重构安全策略）。
- ID/category/schema、URL/HTML、重复引用、推理类型不变量、最终双侧覆盖和邮件预算门。
- `DigestPublicationV2`、renderer、邮件/网页/归档/shown 共用终态 publication。

### 删除终态裁判权

- `FINANCE_RE / HELP_RE / COMPLAINT_RE / GOSSIP_RE`。
- job 审核前的 community 噪声硬删。
- publication 的 event/action/detail/substantive 技术词组合。
- `communityDropIds` 新生产路径和社区 brief 的 AI 关键词二次 veto。

V2EX 的科技话题词表只保留为**抓取高召回启发式**，不得作为编辑批准事实。

## 5. 关键验收矩阵

| 原始内容 | 期望 |
|---|---|
| Sakana “share our latest research… Smart Cellular Bricks” | publish / research，不得触发 finance |
| Nvidia/CoreWeave shares、循环融资 | 可为 industry/finance，绝不 inference |
| vLLM/SGLang 长上下文调度吞吐差异 | publish / technical discussion / inference |
| CUDA graph + dynamic batching 竞态复盘 | publish / engineering / inference |
| GPT-5.6 Sol + Cursor + Blender MCP 完成建模渲染 | publish / engineering / agent |
| 相亲推荐模型离线评测、数据集、A/B | publish / research，生活词不得误杀 |
| ChatGPT Sites public beta + 具体能力 | publish / release，官方发布不自动等于 self-promo |
| 专科大二、底层开发、迷茫求建议 | reject / personal_help |
| 奔三、飘忽不定 | reject / complaint |
| Tim Cook 致信 Sam Altman | reject / gossip |
| vLLM batching 太惊艳、真的喜欢 | reject / reaction_only |
| GPT-5.6 Sol can debug anything, amazing | reject / reaction_only |
| CUDA 只是背景，核心为加班和工资抱怨 | reject / complaint |
| ChatGPT 规划相亲路线、最后独自吃火锅 | reject / off_topic |

这些用例必须穿过 `audit → eligible-only composer input → publication`，不能只测局部谓词。

## 6. 方案分歧与取舍

- **第一份有效审核直接生效**：实现最小，但 evidence 仍由同一模型自证；否决用于 AI/community/podcast，hot 保留单审。
- **三模型全量投票**：质量更稳但每期固定调用 Codex、成本和延迟过高；否决。采用“双 Claude 全量关键域 + Codex 仅冲突”。
- **继续语义正则二次 veto**：会恢复 Sakana/CUDA 摆动和双真相源；否决。
- **embedding/外部 classifier**：需要标注集、阈值校准和新运维面；本期否决。

## 7. 风险与预算

- 两个 Claude 常态审核关键域会增加成本与平均耗时；这是换取语义独立性的明确 tradeoff。`degraded_same_target` 只能保证 Claude 故障时可用，不能消除单模型系统性误判或提示注入相关性。
- 正常 review A(6h) + B(6h) + Codex 冲突裁决(12h) 最坏 24h；Claude 全部 runner 失败时，Claude A/B 保险丝 12h + Codex A/B/C 36h，降级审核最坏 48h。composer 由 `runValidatedStage` 给三个不同 target 各一次机会，最坏 24h。全链降级最坏约 `778350s`，仍小于现有 14d watchdog `1209600s`，余量 `431250s`；不修改 6h/12h 单腿时限。
- scheduler AbortSignal 未贯通 reconcile、Windows taskkill 无回执仍是既有残余风险；本期不借架构调整冒充修复。
- 外层归档和 publication 继续 `schemaVersion: 2`；`EditorialDecisionSet` 是 v2 内新增字段，避免未知版本被旧前端当 legacy fail-open。

## 8. Collaborative-thinking 收敛检查

1. **否决理由 → ADR？** 有；影响仅限 F037，记录在本讨论与 F037 D20，不新增全局 ADR。
2. **踩坑教训 → lessons-learned？** 有；实现闭环后追加“证据 provenance 不等于语义证明；语义分类不得由关键词表或同模型摘要自证”。
3. **操作规则 → 指引文件？** 没有；这是 F037 内部架构合同，不升级全局家规。
