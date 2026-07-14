# B032 — 日报语义正则导致准入摆动

Related: F037

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 社区终态门在多轮严格审核中反复出现“放过求助/抱怨/纯赞叹”与“误杀真实研究/工程复盘”的相反错误；2026-07-14 真发中，Sakana AI 的 `share our latest research` 被当成金融语义，研究条目未进入邮件。 |
| 2 | **证据** | `editorial-policy.ts` 的 `\bshares?\b` 同时匹配普通动词 `share` 与金融名词 `shares`；`publication.ts` 依靠 event/action/detail 正则判断社区实质性。Guardian R4/R5/R6/R7 分别复现个人内容穿透、长 reaction 穿透、CUDA 正例误杀、`debug/batching` 赞叹再穿透；归档 `2026-07-14/items.jsonl` 与 `summary.json` 记录 Sakana 条目 `31c2112228ed8567` 被拒。 |
| 3 | **假设** | 根因不是缺少某个关键词，而是把开放语义分类交给闭集正则，并让同一次摘要输出同时承担审核事实与展示选稿；继续扩表必然在召回与精度之间来回摆动。 |
| 4 | **诊断策略** | 逆向追踪 normalize → LLM 输出 → `applyEditorialPolicy` → `buildDigestPublication` → strict parser；用真实正反例对锁定终态合同；设计“审核决定先冻结、摘要只能消费已批准 ID、证据必须锚定原文”的分层接口。 |
| 5 | **超时策略** | 若设计需要改邮件结构、GitHub 榜单、运行时配置或引入新外部服务，立即停止并缩回编辑判定层；若多模型裁决无法在现有模型/看门狗预算内闭合，先采用单独审核阶段 + 客观一致性校验，不增加关键词裁判。 |
| 6 | **预警策略** | 任何生产路径仍出现正例误杀、反例穿透、摘要引用 rejected ID，或全链最坏账超过 scheduler watchdog，均阻塞补发与合入。 |
| 7 | **用户可见修正** | B032 已通过独立验收与 review；2026-07-14 于 12:33 完成一次真实 force 补发。Claude 两个 target 均不可用时，固定 `gpt-5.6-sol/high` 完成 clean-room 审核与后续模型兜底，邮件成功投递。 |
| 8 | **复现验收** | 用 Sakana research/share、Nvidia shares finance、CUDA 排障/加班薪资、vLLM 调度/纯赞叹、推荐模型 A/B/生活相亲、MCP 双义等成对 fixture 穿过最终 publication；历史归档只读回放；再跑 API 全量、typecheck、docs、build、独立 Guardian 与 peer review。 |

## 当前结论

- 已确认：`FINANCE_RE` 的裸 `share` 是 2026-07-14 Sakana 误杀的直接原因。
- 已确认：社区实质性正则在 R4-R7 中呈现“修漏放 → 误杀正例 → 放宽 → 新漏放”的摆动。
- 已实现：新生产路径删除语义正则的最终裁判职责，以证据化 `EditorialDecider → DecisionSet → DigestComposer` 分层；Composer 只能看到获批原文，publication/job 会重算 hash、重验票据并从 votes 重建 decisions，畸形授权 fail-closed 且不回退 legacy。
- 已验证：Claude 全挂的注入集成矩阵覆盖 7 条正例/7 条反例；真实 `gpt-5.6-sol/high` CLI smoke 与完整 clean-room A/B 降级 smoke 均通过，vLLM 推理获准、V2EX 个人求助拒绝，并如实标记 `degraded_same_target`。邮件格局、开源榜单与 GitHub 逻辑未改。
- 已放行：零上下文 acceptance-guardian PASS；独立 Codex peer review 首轮 2P1（`empty-output` 误触降级、重复 reviewer slot 可伪造授权）均经正式 RED→GREEN，原攻击 probe 2/2、聚焦回归 176/176，定点复审两项 CLOSED、最终 GO。Claude Opus 4.8 当前不可用，本轮如实记录为 Codex review。
- 已补发：2026-07-14 首轮真实 force 运行 `status=ok / degraded=false`，语义审核如实归档为 `degraded_same_target`；ledger attempt `1→2`、outbound `23→24`、六件归档同时刷新。小孙随后明确要求再发一封查看，第二轮同样成功，attempt `2→3`、outbound `24→25`，两轮均各自只新增一条带 messageId 的 allowlist 出站记录。
- 成品核对：AI 15 条中有推理专栏 1 条和推理速览 1 条，其余 13 条覆盖安全、Agent、研究、产品与产业；社区头条另有 vLLM 推理工程进展，14 条社区内容无 V2EX 人生求助；“开源榜单”原名及增长/周榜/新秀/月榜四组保持不变。
- 第二封核对：43/43 源正常，AI 12 条中推理为 EAGLE-3 推测解码在 AMD/vLLM 上的训练与服务进展；社区 15 条、V2EX 0 条；开源榜单四组共 19 项，播客 1 条。
