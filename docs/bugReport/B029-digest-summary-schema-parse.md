---
id: B029
title: F037 真实日报摘要结构化响应解析失败
status: fixed
reported_by: 范德彪（小孙要求真实补发时发现）
reported_at: 2026-07-13
related: F037
---

# B029 — F037 真实日报摘要结构化响应解析失败

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | 2026-07-13 真实 `force reconcile` 完成全源抓取后，摘要尝试 1/3/4 均得到约 18–19KB、尾部形似完整 JSON 的响应，但 production parser 全部拒绝；尝试 2 primary/fallback timeout。四次全败后返回 `failed_summarize`，按宁缺勿发门禁未调用 SMTP。 |
| 2 | **证据** | 首次真实运行 44m37s：GitHub 142→49 个 `yes`，内容 3211→308；parse fail 的 `respLen` 分别为 18725/18588/19196，最终 `failed_summarize`，外发账本保持 21 行。三份 Claude 会话响应均为合法 JSON、loose parse 成功、strict parse 失败。第二次真实运行首稿再次被拒，下一稿收到定点反馈后通过，最终 `status=ok`、`degraded=false`；外发账本 21→22，六个归档文件落盘。 |
| 3 | **假设** | 已证实：不是 JSON 截断。三份真实稿都完整审核了 AI，也满足推理/非推理精选覆盖，但分别漏掉 15/13/14 个被引用 hot 条目的 `editorialAssessments`；同时引用了经 `applyEditorialPolicy` 复核后为 rejected 的 community 条目。 |
| 4 | **诊断策略** | 逆向追踪 `runner text → repair/extract → JSON.parse → production validation`；从 Claude 本地会话还原三份真实响应，分别执行 loose/strict parse；以最小 fixture 固定“被引用 hot 漏审 + community 结构硬拒”两种稳定失败。 |
| 5 | **超时策略** | 30 分钟仍无法从现有产物定位，则仅在本地诊断运行中安全落盘脱敏后的 schema failure code/计数，不记录正文与凭证；禁止再盲跑 45 分钟真实发送。 |
| 6 | **预警策略** | 若修复需要放宽未审核内容发布、跳过推理/非推理覆盖、改 `.env`/运行时配置或直接重发旧归档，立即停止并向小孙说明；这些边界不得为“先发出来”而降低。 |
| 7 | **用户可见修正** | 不改邮件版式、文案、栏目名，不放宽编辑门禁；只有在稿件严格校验失败时，下一轮模型会收到缺失/被拒的内部条目 ID 及固定纠错规则。2026-07-13 新邮件已真实发出。 |
| 8 | **复现验收** | RED：首稿漏 hot 审核且引用被硬拒 community 时，第二次 prompt 缺少任何定点反馈。GREEN：第二次 prompt 明示缺失/拒绝 ID，修正稿仍须通过原 strict parser；161 个 F037 定向测试全绿，API typecheck 与变更文件 lint 通过；真实 `force reconcile` 为 `status=ok`、账本 +1、归档落盘。 |

## Bug Report 六件套

1. **报告人**：范德彪；小孙要求真实补发时发现。
2. **Bug 现象**：摘要模型能返回完整合法 JSON，但 production parser 连续拒绝；四次盲重试后 `failed_summarize`，邮件按宁缺勿发策略未发出。
3. **复现步骤**：构造 AI、hot、community 三条输入；首稿为 AI 写审核、引用 hot 却漏写审核，并把 `contentKind=industry` 的 community 标成 eligible 后选入。loose parse 成功，strict parse 返回 `null`；修复前第二次调用收到与首轮完全相同的 prompt。
4. **根因分析**：B027 的严格门禁正确拦下了不闭合稿件；真正缺陷在重试编排——每次 parse 失败都原样重发同一 prompt，模型不知道上一稿违反了哪条合同，因此稳定重复“漏 hot 审核 + 引用 policy-rejected community”。统一的 `parse failed` 日志又掩盖了语法失败和业务合同失败的差异。
5. **修复方案**：strict parser 保持不变。parse 失败后仅对响应做一次 loose 诊断，使用同一 `applyEditorialPolicy` 计算缺失 AI/引用审核、被结构硬拒引用、推理/非推理精选缺口；把固定文案和最多 24 个内部 ID 追加到下一轮 prompt。反馈不含标题、snippet、URL 或原始模型正文；runner timeout 不清空上一轮反馈。
6. **验证方式**：
   - RED→GREEN：`summarizer.test.ts` 新增定点纠错用例；修复前第二轮 prompt 无反馈，修复后命中缺失 hot ID 与被拒 community ID，并由修正稿通过 strict parser。
   - 定向链路：161/161 通过（editorial-policy、publication、summarizer、renderer、job、shown-ledger、route）。
   - 广域日报测试：397/398 通过；唯一失败是 Windows 环境下既有 YouTube 字幕测试读取 `PATH`/`Path` 的大小写差异，与本次 diff 无关。
   - 静态检查：变更文件 Biome lint 通过；`@multi-agent/api` typecheck 通过。
   - 独立 review：0 个 P1/P2；确认 strict parser 仍为唯一准入、反馈无内容注入面、反馈跨 timeout 保留。
   - 真实外发：第二次 `force reconcile` 首稿被拒后由下一稿修正，`LIVE_SEND_RESULT status=ok, degraded=false`；账本 21→22，`2026-07-13` 归档六文件落盘。

## 非阻塞运行观测

成功外发这一轮仅 6/43 源正常，GitHub 四榜因网络 `fetch failed` 未成节；发后通过同一代理复测 GitHub、smol.ai、HN 均恢复 HTTP 200，初判为一次性上游/代理抖动，不属于 B029 的摘要重试回归。该封邮件能验 B029、推理/非推理共存与社区硬门禁，但不能作为 B028 四榜呈现的完整验收样本。
