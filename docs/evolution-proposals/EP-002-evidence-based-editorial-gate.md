# EP-002: 编辑语义不得由关键词表裁决

> 状态：accepted
> 提案人：范德彪
> 日期：2026-07-14

---

## 1. Trigger（触发）

F037 社区编辑门连续多轮通过追加正则修复漏放，随后又产生相反方向的误杀；小孙明确拍板“正则补丁路线不行”，同意改为分层、证据约束的编辑判定。

## 2. Evidence（证据，至少 2 个来源）

| # | 来源 | 证据 |
|---|------|------|
| 1 | 独立 review / Guardian R4-R7 | 个人求助、薪资抱怨、生活叙事和长纯 reaction 曾穿透；加入动作/细节词后 CUDA 正例先被误杀，补 `debug/batching` 又使同词赞叹穿透。 |
| 2 | 2026-07-14 真发归档 | Sakana AI 的 “share our latest research” 被 `\bshares?\b` 误判为 finance，最终作为 community 非允许类型被拒。 |
| 3 | F037 已拍设计合同 | `docs/discussions/F037-editorial-quality-hardening.md` 已明确“不用更大的关键词表替代语义审核”，实际实现偏离了该合同。 |

## 3. Root Cause（根因）

开放语义（研究、工程、实质讨论、求助、抱怨、金融）被压成闭集关键词匹配；同一模型响应又同时给出审核标签与展示选稿，结构校验只能发现自相矛盾，不能形成独立的审核事实。局部测试曾只覆盖某一层，导致 production-path 正反例未成对锁定。

## 4. Lever（最小杠杆改动）

- **改什么**：只重构 F037 编辑判定层；不改全局 skill/SOP，不动邮件格局、开源榜单、GitHub 排名和运行时配置。
- **怎么改**：正常模式先由两个不同 Claude target 独立产出类型化 basis + 原文证据，冲突只交固定 Codex；全部 Claude target 均为 runner 失败时，由固定 Codex 做互不看答案的 clean-room A/B、分歧才 C，并以 `degraded_same_target` 如实落档，不能冒充多模型独立性。摘要/选稿只消费 final publish ID；确定性代码验证 schema、ID、证据锚定、票来源和栏目一致性，不再用语义词表覆盖决定。
- **为什么这是最小杠杆**：问题局限在 F037 publication 边界，修改全局 prompt 或团队规则不能修复生产数据流；继续扩关键词表已被多轮反例证伪。

## 5. Verify（验证方式）

- **短期**：成对真实 fixture 全部穿过最终 publication；Sakana 正例保留、真实 shares 金融例仍不进推理；摘要无法引用 rejected/unreviewed ID；旧语义裁判正则不再存在。
- **长期**：至少回放最近两期真实归档并比较新增/漏失；下一次真实日报核对 editorial audit、publication 与邮件三者一致，不再以新增关键词修补同类问题。

---

## 审批

- [x] 影响范围确认：单 feature（F037）
- [x] 小孙拍板（2026-07-14：“正则补丁路线不行”）
- [ ] 落地 commit/PR：待 B032 实现与验收
