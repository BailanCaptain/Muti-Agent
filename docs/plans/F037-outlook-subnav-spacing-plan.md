# F037 Outlook 子目录间距修复计划

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 固定 Classic Outlook 顶部子目录标题列，使 `AI 前沿 / 社区动态 / 今日热点` 与右侧标签保持紧凑、稳定的间距，并只向用户指定收件人补发一次修正版。
**Architecture:** Preserve 模式；仅调整 renderer 的 presentation table 列宽合同，不改内容模型、栏目、归档或生产发送状态机。

## Task 1：RED 锁定真实回归

1. 使用 `推理 1 · OpenAI 2 · 研究 2`、`Reddit 1 · Digg 5 · V2EX 2`、`科技 1 · 财经 2 · 体育 1` 构造 renderer fixture。
2. 断言子目录使用 fixed layout，三个标题 cell 均有相同的 64px HTML/CSS 宽度。
3. 确认旧实现只因缺失该结构合同而失败。

## Task 2：GREEN 最小修复

1. 给子目录 table 增加 `outlook-subnav-table` 与 `table-layout:fixed`。
2. 给标题 cell 增加 `outlook-subnav-label`、`width="64"` 和 `width:64px`，移除 10px 右 padding。
3. 保留右侧自然换行，不加 `nowrap` 或空白占位。

## Task 3：验证与合入

1. 运行 renderer、相邻 daily-digest job、typecheck、lint、build 与完整门禁。
2. 对 07-16、07-21、07-22 归档做只读结构回放，记录修复前后间距。
3. 通过独立 Guardian 与 peer review 后合入 `dev`，再重启 Multi-Agent 项目；不重启电脑。

## Task 4：一次性单收件人补发

1. 从 2026-07-22 已发送归档生成只含新布局的 HTML，Markdown、条目、链接和可见文案保持不变。
2. 发送脚本使用 exact allowlist 与 `wx` 原子 marker；不调用 `send-now`。
3. 成功后仅追加一条 outbound ledger 并记录 message id；正式 archive、shown、rank、sent 保持原 hash。
4. SMTP 失败、超时或结果未知时写入 `do_not_retry`，不得自动重试。
