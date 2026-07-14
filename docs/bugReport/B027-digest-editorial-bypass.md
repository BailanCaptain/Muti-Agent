---
id: B027
title: F037 日报编辑门禁绕过与推理假空
status: fixed
reported_by: 小孙
reported_at: 2026-07-13
related: F037
---

# B027 — F037 日报编辑门禁绕过与推理假空

## 用户原话

> 社区动态里面这种内容就不要有了……需要得是 AI 相关的研究、讨论、进展，而不是抱怨和求助。

> 推理栏目是大模型推理相关的研究、进展、讨论……如果真的没有大模型推理相关进展，我可以接受。

> 我想要突出推理，不是只剩推理。

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-12 日报的社区动态出现“奔三了，感觉自己飘忽不定”等非 AI 求助/人生内容；同日 AI 板块没有“推理”子栏，但抓取池中存在 GLM-5.2 int4、LiteRT.js、LongCat-2.0 推理代码、Nemotron 吞吐提升等候选；历史日报曾把 Nvidia/CoreWeave 循环融资归入“推理”。 |
| 2 | **证据** | 归档复现：`.runtime/daily-digest/2026-07-12/digest.md:96`；候选证据：同日 `items.jsonl` 中 GLM/LiteRT/LongCat/Nemotron 条目；代码初查：`summarizer.ts` 在分类前截断 AI feed，`renderer.ts` 的其余速览/直出路径未统一消费编辑批准集合。 |
| 3 | **假设** | H1：AI 候选在语义分类前被全局 cap 截断，导致存在推理候选却未进入 LLM 视野；H2：LLM 只审核精选/有限 feed，而 renderer 直接输出 rest/direct streams，使被拒或未审核内容回流；H3：互斥单标签把主题、公司、地区、开源属性混为一轴，推理条目可能被“国产/开源”覆盖；H4：shown ledger 把 fed-but-unshown 条目视为已展示，加剧后续假空。 |
| 4 | **诊断策略** | 从 `NormalizedItem → selectFeedItems → summarize → renderer → shown ledger` 逆向追踪；用 2026-07-12 真实 fixture 建立失败测试；分别验证候选视野、发布集合闭合、标签归属和账本写入，确认每个边界的输入/输出。 |
| 5 | **超时策略** | 单一假设 30 分钟仍无证据则增加边界诊断测试；连续 3 次局部修补暴露新绕过路径则停止补词表，回到统一发布清单架构并向小孙汇报。 |
| 6 | **预警策略** | 若修复需要改变邮件主要版式、栏目名、发送配置或运行时数据，立即停止并向小孙确认；本修复禁止修改 `.env`、运行时配置或已发送归档。 |
| 7 | **用户可见修正** | 保留原日报格局与文案；AI 子栏完整保留，推理置首并独立扫描；社区只刊登 AI 研究、实质讨论和进展；真正无推理时不拿商业新闻凑数。 |
| 8 | **复现验收** | FAIL→PASS：①“奔三/迷茫/求助”等条目不能出现在社区正式内容或速览；②完整候选池存在合格推理条目时推理非空；③融资类 GPU 商业新闻不能归入推理；④被拒/未审核条目不能从 rest、podcast、YouTube 或 web curated 路径回流；⑤推理不能挤掉其他 AI 子栏；⑥只有实际发布条目进入 shown 冷却。 |

## Scope

- 本 Bug Report 只处理日报内容治理、推理召回、发布门禁和已见账本。
- 邮件整体格局、原有文案、栏目名和现有榜单排版均不改；此前讨论过的“两行容纳方案”不属于本轮实施范围。
- “开源榜单”的 AI 准入、真实增星排序与跨日状态由 B028 独立处理，避免两条根因链相互污染。

## Bug Report 六件套

1. **报告人**：小孙（2026-07-13）。
2. **Bug 现象**：社区动态再次出现非 AI 人生求助；抓取池有推理候选但正式日报没有推理；GPU 循环融资曾被误归为推理。
3. **复现步骤**：以 2026-07-12 `items.jsonl` 只读回放选材，再分别构造“第 25 个才是推理”“24 个推理后才有非推理”“模型漏掉任一侧”“社区求助被模型批准”“融资请求推理标签”“终态 publication 被裁空”等 fixture，贯穿 summarizer → publication → renderer → archive/web/shown。
4. **根因分析**：语义审核前的类别 cap 会截走推理或非推理；旧 renderer 能从 raw/rest/direct streams 自行补位；展示标签曾承担审核事实；overview、archive/web/shown 没有共同消费一份终态发布清单；模型输出也未被要求完整审核 AI 输入及同时覆盖合格的推理/非推理两侧。
5. **修复方案**：增加结构化 `editorialAssessments`、`overviewRefs` 与版本化 `DigestPublicationV2`；候选视野同时保护推理和非推理；模型必须审核全部 AI 输入，存在合格两侧时稳定精选位必须各有至少一条，brief/支持引用不能冒充覆盖，否则重试；社区硬边界与融资降类在 publication 前复核；邮件、网页、归档、统计和 shown 统一消费预算裁剪后的 publication；初建 publication 与终态密度/字节裁剪后均复核双侧覆盖，终态为空或只剩一侧则不发送并等待下一轮重试。
6. **验证方式**：独立 acceptance-guardian PASS；Claude Opus 4.8 正式 review GO（0 P1/P2）；F037 相关 API/Node 最终回归 254/254、web model 18/18、Playwright 11/11、2026-07-12 只读历史回放及 typecheck/lint/docs/diff gate 均通过，状态改为 fixed。
