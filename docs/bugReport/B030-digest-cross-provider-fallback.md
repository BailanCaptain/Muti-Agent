---
id: B030
title: F037 日报模型兜底与 Claude 主链同故障域
status: verification
reported_by: 小孙
reported_at: 2026-07-14
related: F037
---

# B030 — F037 日报模型兜底与 Claude 主链同故障域

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | FFmpeg 修正后，全链预检恢复到 42/43 源正常，但 `podcast-transcribe` 仍失败，日报总摘要也四次全败。现有“主力/兜底”看似有两层，实际都调用 Claude CLI；组织关闭 Claude subscription access 时两层同时失效，播客提炼和整封日报均无法完成。 |
| 2 | **证据** | 最小 Claude 探针明确返回“organization has disabled Claude subscription access”；Anthropic API Key、Bedrock、Vertex 均未配置。代码中 `boot.ts` 用两个 `createClaudeModelRunner` 构造 fallback。相同环境下 `codex exec --ephemeral ... -m gpt-5.6-sol -c 'model_reasoning_effort="high"'` 返回精确 `MODEL_OK`、exit 0。 |
| 3 | **假设** | 已证实：唯一失败源不是 FFmpeg/STT，而是转写完成后的 LLM 提炼；日报摘要失败与它同根。跨 provider 的固定第三层能覆盖 Claude CLI 整体不可用，但不得绕过摘要 JSON、编辑审核、推理/非推理覆盖或“宁缺勿发”门禁。 |
| 4 | **诊断策略** | 分层验证 `音频→FFmpeg→STT→LLM`，再用 Claude/Codex 最小探针隔离 provider；静态追踪 boot 接线，确认摘要和播客共用 runner。实现采用有序目标去重、成功短路和 abort 停链，并补齐 Codex 子进程取消测试。 |
| 5 | **超时策略** | 先跑无外发的结构化摘要探针，再跑隔离目录 mock 全链；任何一步失败都不得触发 SMTP。B031 实测统一 360s 会误杀慢模型；按小孙 07-14 决策，Claude 至少 30min/层、最终 Codex/high 至少 2h。后续专项审计又发现播客 15min 外层会截断该兜底，现改为播客整源 12h、整任务 watchdog 36h；AbortSignal 触发仍须终止进程树并停止后续模型。 |
| 6 | **预警策略** | 若需要修改 `.env`、MCP/runtime 配置、降低既有 strict parser/发布门禁、改变邮件格局文案或直接复用旧摘要发送，立即停止并报告。这些均不属于本修复授权。 |
| 7 | **用户可见修正** | 设置页原有两列不动；其下增加只读说明“最终兜底：GPT-5.6 Sol · Codex · high，仅前两层均失败时启用”。强度固定 high，不新增可持久化字段。邮件内容和栏目呈现不变。 |
| 8 | **复现验收** | RED：两个 Claude runner 都失败后没有跨 provider 调用，Codex runner 忽略 AbortSignal。GREEN：链路严格按 Claude 主力→Claude 备用→`gpt-5.6-sol/high`，去重且成功短路；摘要/播客均接入；GET 下发只读描述、PUT 拒绝伪造字段。B031 后的完整隔离 mock 全链已为 43/43、`status=ok`、`degraded=false`、六件归档+mock 邮件；正式补发仍等独立验收与 review。 |

## Bug Report 六件套

1. **报告人**：小孙；在 FFmpeg 修正后追问唯一失败的 `podcast-transcribe`，并要求增加 `gpt-5.6-sol` 兜底，推理强度固定 high。
2. **Bug 现象**：配置表面存在 primary/fallback 两个模型，但二者同属 Claude CLI 故障域。Claude 组织权限被关闭时，日报摘要与播客提炼同时失去全部 LLM 能力。
3. **复现步骤**：在不改配置的隔离预检中完成抓取、FFmpeg 和 STT；观察播客在 LLM 提炼阶段失败、主摘要四次失败。分别运行最小 Claude 与 Codex 探针，前者返回组织禁用，后者以 `gpt-5.6-sol/high` 成功。
4. **根因分析**：`buildRunOverrides()` 把 `primaryModel` 与 `fallbackModel` 都交给 `createClaudeModelRunner`；现有 fallback 仅跨模型、不跨 provider，因此不能承受 Claude CLI 账户/组织级故障。现成 Codex runner 可复用，但尚未响应调用方 AbortSignal。
5. **修复方案**：保持存储 schema 和两列配置不变，增加不可持久化的终极目标 `{ provider: "codex", model: "gpt-5.6-sol", effort: "high" }`。每轮构造有序目标、按 provider/model/effort 去重，成功立即短路；abort 立即停链。为 Codex runner 补预取消和运行中进程树终止；同一 runner 继续供摘要、翻译补全和播客提炼使用。设置 API 只读下发终极兜底描述，前端只展示、不提交。
6. **验证方式**：TDD 覆盖三层成功/失败/去重/abort、路由只读合同和前端 payload；真实 `gpt-5.6-sol/high` 通过结构化探针。完整隔离 reconcile 中三份播客、主摘要、深读和翻译均由第三层成功兜底，最终 43/43 源健康、`status=ok`、`degraded=false`、六件归档与 mock 邮件落盘；全量测试与 F037 E2E 通过。只有独立验收与正式 review 放行后才补发新邮件。

## 设计决策

- 采用固定第三层，不把 GPT 替换成现有 Claude 备用；这是“再多一层”，不是“只剩 GPT”。
- 不新增 provider/effort 可编辑 schema，不做配置迁移；`high` 是运行时固定事实。
- 不做 parser 级自动换模型：CLI 成功但 JSON 不合格仍由现有定点纠错重试处理，strict parser 与发布门禁不变。
- 不新建 ADR：这是 F037 既有 runner 接线缺陷的局部修复；被否决的“UI-only 选项”“替换第二层”“通用 provider 配置器”记录在本报告即可。
