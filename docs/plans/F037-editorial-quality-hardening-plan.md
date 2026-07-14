# F037 内容质量加固实施计划（B027 / B028）

**目标：** 修复日报编辑门禁绕过、推理假空、GitHub 非 AI 混入和增星排序失真，同时保持现有邮件格局、文案、栏目名与榜单排版不变。

**Bug：** [B027](../bugReport/B027-digest-editorial-bypass.md) / [B028](../bugReport/B028-github-ranking-ai-eligibility.md)

**设计收敛：** [F037 内容质量加固](../discussions/F037-editorial-quality-hardening.md)

## Non-goals

- 不做邮件两行改版、视觉 restyle、栏目重命名或双轨榜单。
- 不修改 `.env`、MCP/runtime 配置、已发送归档或真实外发账本。
- 不发送真实邮件；验证只在 feature worktree 的临时目录/preview 中进行。

## Task 1：B027 RED — 锁定四个绕过边界

先在现有 `summarizer.test.ts`、`renderer.test.ts`、`daily-digest-job.test.ts`、`shown-ledger.test.ts` 增加失败测试：

1. 第 25 个 AI 候选是合格推理时仍进入审核视野。
2. GPU 融资不得标为推理；推理与非推理内容同时存在时两者都发布。
3. 社区标题/正文属于求助或抱怨，即使提到 AI 创业也不得发布。
4. rejected/unreviewed 条目不得被 renderer 的 rest、podcast、YouTube 或 web curated 路径发现。
5. 邮件字节预算裁剪后，邮件、web 和 shown ledger 使用同一最终发布集合。

检查点：测试必须在当前实现上按预期失败，并保存命令与失败断言。

## Task 2：B027 GREEN — 唯一发布清单

1. 在 `types.ts` 增加版本化 editorial assessment / publication manifest；发布与审核状态分离。
2. `summarizer.ts` 从完整新鲜 AI 池先保护推理候选，再做常规 cap；语义输出明确审核状态、内容类型和展示 tag。
3. 建立 publication validator：ID 必须存在、category 匹配、单次只展示一次、rejected/unreviewed 禁止发布。
4. `renderer.ts` 仅消费 publication，不再从 raw pool 发现内容；现有 HTML/CSS/文案保持不变。
5. `daily-digest-job.ts` 在预算裁剪后固化最终 publication；archive/web/shown ledger 均消费同一集合。
6. 为历史 `summary.json` 保留只读兼容 adapter，不改已发送归档。

检查点：Task 1 全绿；现有 renderer/job/web 回归全绿。

## Task 3：B028 RED — 锁定准入、排序和状态

在 `github-trending.test.ts` 与 job/ledger 测试中增加失败测试：

1. Agent-Reach 核心用途证据充分 → `yes`；IPTV、可选 AI、通用 `agent` → `no`；证据/README 失败 → `unknown` 且不发布。
2. AI 判断只做 filter；榜内严格按窗口新增 star 降序，稳定 tie-break。
3. 增星数缺失/不可解析的条目失败关闭，不静默补 0。
4. 周榜/月榜跨日重复仍展示；增长榜/新秀榜分别产生 NEW、连续 X 日、重新上榜。
5. 同一期同仓只显示一次，保留现有四组顺序和 caps。

检查点：测试在当前 `aiWeight` / 全局去重实现上失败。

## Task 4：B028 GREEN — 结构化 GitHub 数据

1. 将 repo、description、language、totalStars、windowStars、period、topics、README 证据建成结构化类型，不再依赖 renderer 反解析 `rawSnippet`。
2. AI eligibility 采用强/弱结构化信号 + README 语义复核，落 `yes/no/unknown + confidence + reasons`；仅 `yes` 进入榜单。
3. 删除 AI 排名倍率；每榜按 `windowStars desc` 排序并用确定性 tie-break。
4. 将跨日状态存入独立、可注入的临时状态存储；只为增长榜/新秀榜计算状态，周榜/月榜不读冷却。
5. 保持 renderer 现有 DOM/HTML/CSS/榜名/分组名不变，只把状态作为既有元信息的数据值传入。

检查点：Task 3 全绿；现有 GitHub/renderer 快照不发生非预期布局变化。

## Task 5：真实历史回放与边界验证

1. 用 2026-07-12 `items.jsonl` 复制到 worktree 临时 fixture，禁止改原归档。
2. 跑编辑决策回放，记录候选数、拒绝原因、推理命中和最终发布 ID。
3. 用固定 GitHub fixture 验证 IPTV/Agent-Reach、真实增星顺序和四榜成员归属。
4. 比较渲染前后结构：栏目名、主要 HTML 层级和现有排版断言不变。
5. 跑专项测试、API 全量测试、typecheck、docs check。

## Task 6：门禁与正式 Review

1. `quality-gate`：逐条对照小孙原话、B027/B028 验收合同和 non-goals。
2. `acceptance-guardian`：零上下文 agent 在同源 worktree 复跑历史回放与测试。
3. `requesting-review`：把 Why / What / Context / Tradeoff / Open Questions、完整 diff、红绿证据和残余风险交给 **Claude Opus 4.8**，明确只读审查。
4. 如 reviewer 提出 P1/P2，按 `receiving-review` 逐项 VERIFY，再用 RED→GREEN 修复；未获 GO 不交付。
