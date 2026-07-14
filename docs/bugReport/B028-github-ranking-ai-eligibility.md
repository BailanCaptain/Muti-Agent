---
id: B028
title: F037 开源榜单 AI 准入与增星排序失真
status: fixed
reported_by: 小孙
reported_at: 2026-07-13
related: F037
---

# B028 — F037 开源榜单 AI 准入与增星排序失真

## 用户原话

> Agent-Reach 按照这个方案还有会有吗？

> 我觉得你提的这个方案不好，太乱了。

> 周榜和月榜无所谓去不去重，一直有新的增长顶上来去掉某一个就行。周榜和月榜本来就没有隔日去重的意义，增长榜和新秀榜才有。你说的那个连续 X 日上榜可以在这里面加。

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | “开源榜单”会收录 IPTV 等非 AI 仓库；增长榜并非严格按窗口增星排序；同一仓库跨四榜的处理和跨日状态语义混在一起。 |
| 2 | **证据** | `sources/github-trending.ts` 以 `windowStars × aiWeight` 重排，导致低增星 AI 仓库可越过高增星仓库；新秀榜使用 `topic:mcp created:>7d` 且按累计 star，不是统一的 AI 准入后真实增星口径；当前全局 URL 去重让日榜先到者吞掉周/月榜成员资格。 |
| 3 | **假设** | H1：AI 相关性同时参与准入和排名，混淆了两个概念；H2：描述/主题的弱关键词把非 AI 仓库误判为 AI；H3：跨榜去重与跨日状态没有分层，造成周/月榜错误抑制或增长/新秀重复缺少解释。 |
| 4 | **诊断策略** | 分别锁定四个纯函数合同：AI eligibility、窗口增星数解析、榜内排序、跨日状态；先用 IPTV/Agent-Reach/弱 `agent` 词/相同增星等 fixture 写失败测试，再接入 source/job。 |
| 5 | **超时策略** | 若 GitHub topics/README 获取失败，条目记为 `unknown` 并 fail-closed，不为凑榜放行；若无法得到可靠窗口增星数，整条不参与排名，不用 0 静默兜底。 |
| 6 | **预警策略** | 不拆“AI 工程榜/全站趋势榜”，不新增榜名，不改变邮件整体格局、原有文案和现有榜单排版；不改 `.env` 或 GitHub token 配置。 |
| 7 | **用户可见修正** | 总名保持“开源榜单”，四组保持“增长榜 · 今日 / 周榜 / 新秀 · 7 天新仓 / 月榜”；先做 AI 准入，再严格按真实增星排序；Agent-Reach 可入，IPTV 不入。 |
| 8 | **复现验收** | FAIL→PASS：① Agent-Reach 准入且弱 `agent` 非 AI 仓拒绝；② IPTV 拒绝；③ AI 判定不改变排序，窗口增星降序稳定；④同一期同仓只显示一次；⑤周榜/月榜不做跨日抑制；⑥增长榜/新秀榜显示 NEW、连续 X 日或重新上榜。 |

## 决策合同

### AI 准入

GitHub 没有官方 `isAI` 字段。准入采用“结构化信号 + README 语义复核”，结论为 `yes / no / unknown`：

- `yes`：仓库核心用途是模型训练/推理/评测，Agent/MCP/RAG/AI Coding，模型/数据集/benchmark/安全，直接 AI 基础设施，或以 AI 为核心能力的应用。
- `no`：仅顺带提到 AI、仅“built with AI”、AI 是可选边缘能力，或本体是 IPTV/播放器/壁纸/游戏/通用工具；通用语义的 `agent` 不算 AI 证据。
- `unknown`：topics、description、README 证据不足或读取失败；发布侧 fail-closed，但保留可审计原因。
- AI 结论只决定能否入榜，绝不参与排名分数。

### 排名与跨日状态

- 四榜分别按各自窗口的真实新增 star 降序；数值缺失不以 0 放行。
- 同一期同一仓库只展示一次，按“增长榜 → 周榜 → 新秀榜 → 月榜”的现有顺序归属。
- 周榜/月榜每天重算当前排名，不做跨日去重。
- 增长榜/新秀榜保留跨日状态：首次为 `NEW`；连续上榜为 `连续 X 日上榜`；中断后再入榜为 `重新上榜`。

## Scope

- 只改 GitHub 数据获取、AI 准入、排序、榜间归属和跨日状态。
- 邮件整体格局、原有文案、栏目名和现有榜单排版不变。
- 日报通用编辑门禁和“推理”召回由 B027 处理。

## Bug Report 六件套

1. **报告人**：小孙（2026-07-13）。
2. **Bug 现象**：IPTV 等非 AI 仓库可能进入“开源榜单”；增长榜不是严格按真实增星排序；周/月的重复语义与增长/新秀的跨日状态混为一谈。
3. **复现步骤**：用 Agent-Reach、IPTV、通用 `agent`、仅 built-with-AI、证据失败仓库和不同 `windowStars` 的固定 fixture，跑四榜源、同仓去重、job 状态落盘以及邮件/web 展示。
4. **根因分析**：旧实现用 `windowStars × aiWeight` 同时表达准入和排名；弱关键词可把非 AI 核心仓库加权放行；新秀查询又被 `topic:mcp` 限死；跨榜去重与跨日展示状态没有独立数据模型。
5. **修复方案**：建立结构化 GitHub metadata/topics/README 证据与 `yes/no/unknown` 准入，只有 `yes` 发布；四榜在准入后严格按 `windowStars → totalStars → repo` 排序；四榜 HTML、Search API、metadata 与 README 请求共用 evidence cache 和同一个全局并发闸，预算统一为 180 秒；调用方 abort 贯穿 SafeHttp 的 DNS 校验与 fetch，在途失败后释放并发槽且按 promise identity 清除失败缓存，允许下一轮重试；同一期保持既有四组优先级去重，跨榜冲突仅在更高 evidence priority 替换时先 `delete` 再 `set`，使替代项回到当前榜种的原始有序位置，同优先级仍保持增长榜 → 周榜 → 新秀榜 → 月榜的先到优先；仅增长/新秀计算 NEW、连续 X 日、重新上榜，周/月不跨日抑制；HTML/CSS、总名“开源榜单”和四组名称不变。
6. **验证方式**：独立 acceptance-guardian PASS；Claude Opus 4.8 首轮正式 review GO（0 P1/P2、1 P3），唯一 P3 为更强 GitHub evidence 跨榜替换保留旧 `Map` 插槽导致新秀榜错位；`12624e8` 以 RED `[shared, top, tail]` → GREEN `[top, shared, tail]` 关闭，orchestrator 7/7、F037 相关 API/Node 254/254、全量 components 901/901；同模型定点复审确认原 P3 CLOSED、无新增 P1/P2/P3、最终 GO，状态改为 fixed。
