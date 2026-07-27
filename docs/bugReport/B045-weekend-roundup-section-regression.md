---
id: B045
title: F037 周一周末速览栏目与信源回归
status: fixed
reported_by: 小孙
reported_at: 2026-07-27
related: F037, B044
---

# B045 — F037 周一周末速览栏目与信源回归

讨论纪要：[F037 B045 周一栏目与失效信源纠偏](../discussions/F037-B045-weekend-roundup-correction.md)

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-27 实发的周末速览只剩 AI / 社区动态 / 今日热点三栏；播客（用户口述“博客”）与开源榜单没有出现，邮件仍显示 `Digg AI 1000(failed)`。 |
| 2 | **证据** | 07-27 归档终态为 `ai:14 / hot:1 / community:9 / podcast:0 / github:0`，source health 仅 39 路（38 ok + Digg 429）；正常日报 07-23 为五栏且 GitHub 19 条。`daily-digest-job.ts` 在周一将 `githubSources` 直接置空；`renderer.test.ts` 又把“不含开源榜单”锁成期望。播客源本身 `ok`，5 个缓存候选均不在上海周六/周日日期窗，renderer 按既有空节规则隐藏整栏。10 个官方 blog 源全部 `ok`，周末合资格新文为 0。Digg `/tech/` 与 `/ai` 用当前生产同姿势持续返回 HTTP 429。 |
| 3 | **假设** | H1 已证实：B044 把“周一正文只取周末”错误扩大为“周一删除状态型 GitHub 榜单”，且测试/文档共同固化了错误合同。H2 已证实：固定五栏契约未被 renderer 表达，条件栏为空时栏目结构动态收缩。H3 已证实：Lobsters 官方 AI 标签 RSS 活体返回 200、25 条，现有 parser 25/25 可解析，可等量替换持续 challenge 429 且依赖私有 RSC 的 Digg。 |
| 4 | **诊断策略** | 对比 07-23 与 07-27 publication、sourceHealth 和 HTML；逆向追踪 `weekendRange → githubSources → publication → renderer`；活体验证候选公开 RSS；建立 Monday 混合日期 + GitHub 四榜、Monday 五栏空态、持续 429 源替换三组 RED。 |
| 5 | **超时策略** | 候选 RSS 若在 SafeHTTP/代理同姿势下 20 分钟内不能稳定 200 + 解析非空，放弃该候选，不叠加绕限流手段；三轮实现仍不能稳定恢复五栏则停止并回到栏目架构复审。 |
| 6 | **预警策略** | 不修改 `.env`、代理、Cookie、运行时配置，不重启现有 runtime；不把周五/周一正文塞进周末合辑，不允许 GitHub 或空态兜底审核链全失败的空壳邮件。 |
| 7 | **用户可见修正** | 周一仍严格只收周六/周日新闻，但恢复正常五栏结构；开源榜单标明为周一时点快照；无周末播客时诚实显示空态；持续 429 的 Digg 从运行清单移除并由稳定公开 AI 社区 RSS 等量替换。 |
| 8 | **复现验收** | 周一会运行并展示 GitHub 四榜，正文日期仍只有周六/周日；无播客时仍显示“播客速递 / 本周末暂无新节目”；43 路清单不再含 Digg、替代源生产同姿势健康；仅 GitHub/空态时仍零归档、零 attempt、零 shown、零 outbound；周二至周五既有五栏行为不回归。 |

## 原始反馈

> “你这个也不对啊 信源还是有失效的 而且栏目只剩3个了 博客和开源没了”

## 根因分析

1. **报告人 / 时间**：小孙，2026-07-27。
2. **Bug 现象**：周一修正版实发只有 AI、社区、热点三栏；播客与开源消失，Digg 仍失败。
3. **复现步骤**：
   1. 回放 2026-07-27 publication：`podcast=0 / github=0`，最终 HTML 只有三栏。
   2. 以周一业务日调用旧 `reconcile()`：`weekendRange` 会把 `githubSources` 直接替换为空数组。
   3. 给 renderer 传入无播客的周一 publication：空 section 被动态过滤，刊头又从剩余 section 生成。
   4. 用生产同姿势读取 Digg `/tech/` 与 `/ai`：均持续返回 `429` 和 `X-Vercel-Mitigated: challenge`，无 `Retry-After`。
4. **根因**：时间范围、栏目结构和 source 恢复被混成一个问题。新闻日期门错误控制了无日期的 GitHub 状态榜；renderer 把“无内容”解释成“栏目不存在”；Digg challenge 被误判成可由普通 GET retry 恢复的暂态限流。
5. **修复**：GitHub 四榜脱离周末新闻日期门并继续受 AI 准入与非空壳门保护；周一邮件、Markdown 与网页版固定五栏，只在真正无合资格内容时显示无链接空态；密度隐藏与 publication/shown 继续解耦并给出诚实说明。`digg-ai` 从 boot、设置元数据和 allowlist 退休，registry 等量接入 `lobsters-ai`，保留 Digg label/tab 仅供旧归档读取；真网 smoke 同步四榜并修正历史失效的 SafeHTTP import。
6. **验证方式**：TDD 首轮得到 GitHub 调用 0、周一五栏缺失、Lobsters 未注册三组 RED；首轮 guardian 又阻塞“正文仍写今日热点”和“smoke 仍跑 Digg”，peer review 再阻塞网页版、英文眉题与密度空态三项 P2，均经新 RED→GREEN 关闭。终态专项为 API `144/144`、Digest 组件 `30/30`；typecheck、lint、check、build 与全量 `pnpm test` 均为 0 失败，peer review 已 APPROVE，增量 acceptance r3 已 PASS。
7. **实发验收**：2026-07-27 修正版以 `status=ok / degraded=false` 发出，主题为 `📰 DailyBrief 2026-07-27 · 周末速览（07.25—07.26）`；外发账本严格由 `46→47`。最终 Markdown/HTML 固定显示 `AI → 社区动态 → 周末热点 → 播客速递 → 开源榜单` 五栏；本周末无新播客时显示诚实空态，开源榜单共 16 条且四榜源齐全。正文 22 条的上海日期仅为 07-25/07-26、越界 0；source health `43/43 ok`，`lobsters-ai=25 items`，运行清单无 `digg-ai`。
