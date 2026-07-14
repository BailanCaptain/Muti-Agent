---
id: B033
title: F037 首封正式日报的速览密度、YouTube 瞬时失败与去重基线不可靠
status: verification
reported_by: 小孙
reported_at: 2026-07-14
related: F037
---

# B033 — F037 首封正式日报发布可靠性

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | 2026-07-14 12:33 补发中 12 个 YouTube 源出现 7 个 404、1 个 500；同一日报的“今日速览”条数明显缩水。若直接沿用现有 shown ledger，2026-07-15 07:30 的首封正式日报还会被此前测试/补发记录跨日抑制。 |
| 2 | **证据** | 同一代码在 22:44 再跑时 YouTube 12/12 正常，证明 12:33 不是定义整体失效；RSS feed 当时每源只有一次请求。B032 新 `DigestComposer` prompt 漏写既有“5–8 条”合同，parser 只保留旧上限 10，且邮件字节裁剪后没有终态密度复核。shown ledger 默认无条件读取近 30 天。 |
| 3 | **根因** | 三个边界分别缺合同：Composer 重构时遗漏展示密度；YouTube 官方 feed 的瞬时 CDN/网关状态被单次请求直接固化为 failed；正式投产日没有与试发账本分开的 epoch。它们不是邮件版式、栏目名或 GitHub 排序问题。 |
| 4 | **修复策略** | Composer 在获批输入 ≥5 时强制 5–8 条独立速览，禁止重复 ID 凑数并要求引用最终发布条目；publication 经字节裁剪后再次 fail-closed 校验。仅 YouTube RSS 对 404/408/425/429/500/502/503/504 做一次短延迟重试，403 等永久错误不重试。shown ledger 增加 `notBefore=2026-07-15`，保留但忽略此前文件。 |
| 5 | **边界** | 不改邮件格局、原有文案、“开源榜单”名称与四组榜单；不全局重试所有源，不放宽 SSRF/超时；不删除历史 shown 数据，不修改 `.env`。周榜/月榜不做跨日去重的既有语义保持不变。 |
| 6 | **验证方式** | 三组原症状 RED 已分别复现：Composer 4 条/重复引用被接受、YouTube 404 不重试且 `SafeHttpError` 无 status、首发日仍被 07-14 shown 抑制。GREEN 后联合专项 189/189；另有 publication 与 job 两层终态速览门禁测试，五条获批但只剩四条时不得发送或写 sent。 |

## Bug Report 六件套

1. **报告人**：小孙；要求 2026-07-15 07:30 作为第一封正式日报，并明确去重从该日开始计算。
2. **Bug 现象**：试发中 YouTube 大面积瞬时失败、今日速览过少，且历史试发 shown 会污染首发选材。
3. **复现步骤**：让 Composer 对 5 条获批输入返回 4 条或重复引用；让 YouTube feed 第一次返回 404、第二次返回有效 RSS；先写入 2026-07-14 shown，再以 2026-07-15 运行同一条目。旧实现分别接受缩水摘要、只请求一次并失败、过滤掉首发条目。
4. **根因分析**：B032 重构只迁移了结构 schema，没有迁移 5–8 展示合同；feed 链只处理 URL fallback，不处理同一 URL 的瞬时 HTTP 状态；shown ledger 只有回看天数，没有生产 epoch。
5. **修复方案**：动态 Composer 密度合同 + distinct/发布可见引用校验 + 终态 publication 密度门；YouTube opt-in 两次请求策略并透传 AbortSignal；`F037_FORMAL_DEDUP_START_DATE=2026-07-15` 在 production boot 注入，旧调用保持兼容。
6. **验证方式**：summarizer、publication、job、shown-ledger、safe-http-client、registry、真实 B032 pipeline 的定向测试全部通过；随后执行 API 全量、typecheck、组件/E2E/构建、零上下文 Guardian 与 peer review，全部放行后才允许合入并启用正式 07:30 运行。

## 正式首发合同

- 2026-07-15 07:30 是正式去重 epoch；此前试发文件原样保留，只是不参与候选过滤。
- 07-15 实际发布且成功发送的终态 publication 才写入当天 shown，并从 07-16 起参与跨日抑制。
- 失败、未发布、被字节预算裁掉的条目不写 shown；force 试发不会覆盖同日已有集合。
- runtime 必须在合入后加载新构建并保持 scheduler 启用；若 07:30 主触发失败，整点安全网沿用同一个 `reconcile` 重试。
