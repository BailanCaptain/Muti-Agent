---
id: B044
title: F037 周末日报空壳与周末发送节奏纠偏
status: in_progress
reported_by: 小孙
reported_at: 2026-07-27
related: F037
---

# B044 — F037 周末日报空壳与周末发送节奏纠偏

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-25（周六）邮件几乎只剩 GitHub 榜单，用户观感为“信源又失效”；2026-07-26（周日）Digg 返回 HTTP 429。现有调度还会在周六、周日照常发送，不符合新的周末阅读节奏。 |
| 2 | **证据** | 07-25 归档实际为 42/43 个 source 正常、423 条原始候选；唯一源失败是播客转写。84 条编辑决策全部为 `unreviewed / classifier_failure`，Claude 主备与 Codex fallback 均 exit 1，但非空的空摘要仍进入 publication，GitHub 条目使“非空日报”总门通过并完成 SMTP。当前最小 Claude 探针明确报 OAuth session expired。07-26 为 42/43 正常，仅 `digg-ai` HTTP 429。 |
| 3 | **假设** | 已证实有四个相邻缺口：① publication 只检查“任一板块非空”，没有要求至少一条经编辑批准的新闻正文；② reconcile 三入口没有周末业务日门禁；③ 周一若只沿用 24h 窗口，会漏掉周六的 HN/X 条目；④ Digg 没有对偶发 429 使用现有的 source 级幂等 GET 重试。 |
| 4 | **诊断策略** | 以正式归档、外发账本和当前只读模型探针还原 07-25/26；分别用 GitHub-only publication、周六/周日自动 reconcile、周一跨日边界、HN/X 72h 和 Digg 429→成功 fixture 建立 RED。 |
| 5 | **超时策略** | 若任一 RED 不能以旧行为稳定复现，停止扩展修改并回到对应正式归档；若需要改变 scheduler/runtime 配置或邮件总体版式，升级设计复审。 |
| 6 | **预警策略** | 禁止修改 `.env`、模型凭证、MCP/运行时配置或重启现有 runtime；周末门禁必须位于 reconcile 单入口，不能只改 cron；周一必须严格只收上海时区周六、周日有发布日期的新闻，不能混入周五、周一或无日期榜单。 |
| 7 | **用户可见修正** | 周六、周日自动停发；周一发送周末两天新闻合辑，标题增加小字 `周末速览 · SAT–SUN ROUNDUP` 与覆盖日期；周一不混入 GitHub 当前榜单。处理链失败统一称“信源/处理异常”，不再把模型失败误写成“抓取失败”。 |
| 8 | **复现验收** | 周末非 force 零抓取/零归档/零发送并返回非失败态，force 保留人工补发能力；周一只送周六、周日且可重收过渡期已在周末发过的内容；GitHub-only 空壳 fail-closed；Digg 首次 429 后仅重试一次可恢复；HN/X 周一回看 72h、其他日仍 24h；renderer 的 subject、刊头小标题、Markdown 与异常文案一致。 |

## 原始需求

> “最近的信源又有一点失效，特别是周六周日两天的，去看看为什么修复一下。”
>
> “以后周六周日的时候不发了，周一的时候整合周日的时候发，相当于周一的时候是一个周末的新闻的速览整合……周一只是整合周末的，周末不发，不是大改。”
>
> “做完直接发一版我看看。”

## Bug Report 六件套

1. **报告人**：小孙，2026-07-27。
2. **Bug 现象**：见诊断胶囊；07-25 的主要症状并非 source 大面积失败，而是编辑链全失败后仍发出 GitHub-only 空壳邮件；07-26 另有 Digg 429。
3. **复现步骤**：
   1. 读取 `.runtime/daily-digest/2026-07-25/summary.json` 与 source health：42/43 source 正常、内容终态为 0、GitHub 为 18。
   2. 读取同轮模型日志：全部审核/成稿 target exit 1；构造非空 `DigestSummary` 但没有任何正文批准项，旧 job 仍因 GitHub section 非空而发送。
   3. 在周六或周日 07:30 后调用非 force `reconcile()`：旧实现继续抓取、归档并发送。
   4. 在周一抓取仅保留 24h 的 HN/X：周六条目在进入严格周末过滤前已经丢失。
   5. Digg 首次返回 `SafeHttpError(http_status, 429)`、第二次返回正常 fixture：旧源没有 opt-in retry，结果直接失败或落 fallback。
4. **根因分析**：编辑成稿对象“非 null”与“至少一条经批准新闻正文”被错误等同；GitHub 榜单绕过了正文终态门。发送日历只实现时间门，没有业务星期门。源侧 24h 窗口与新的周一周末合辑语义不匹配。Digg 429 属可恢复 GET，但未声明现有受控重试策略。Claude OAuth 过期属于环境状态，按配置不可变纪律不在代码内伪修。
5. **修复方案**：待 RED 完成后，以 reconcile 单入口周末门、周一上海本地日期窗口、新闻正文终态门、周一 HN/X 72h lookback、Digg 单 token 429 retry 和 renderer 条件文案做最小修改；force 仅保留人工显式覆盖。
6. **验证方式**：待 GREEN、全量门禁、独立验收、peer review 与真实单次 SMTP 发信后补全证据。
