# Multi-Agent Feature Roadmap

> **用途**：Feature 追踪索引表。每个 Feature 立项时在此注册，完成后移至「已完成 」表。
> **聚合文件**：每个 Feature 的详细 spec 在 `docs/features/Fxxx-name.md`。

## 活跃 Features

| ID | 名称 | 状态 | Owner | Source | Spec |
|----|------|------|-------|--------|------|
| F007 | 上下文压缩优化：Microcompact + SOP书签 + 自动续接 + 动态预算 + 语义检索 | spec | 黄仁勋 | internal | [F007](features/F007-context-compression-optimization.md) |
| F008 | 开发基础设施 + 视觉证据链：Hot-Reload + ImageBlock + 日志 + 截图 | spec | 黄仁勋 | internal | [F008](features/F008-dev-infra-evidence-chain.md) |
<!-- 新 Feature 在此行上方添加 -->

## 已完成 Features

| ID | 名称 | 完成日期 | Spec |
|----|------|---------|------|
| F001 | UI 焕新：配置入口统一 + 消息渲染升级 | 2026-04-10 | [F001](features/F001-ui-refresh.md) |
| F002 | Decision Board – 讨论级拍板收敛 | 2026-04-11 | [F002](features/F002-decision-board.md) |
| F003 | A2A 运行时闭环 – 回程派发 + Stop Reason 续写 + SOP 派发 | 2026-04-11 | [F003](features/F003-a2a-convergence.md) |
| F004 | 上下文记忆权威化 – 历史从 API 注入 + 删除 Gemini fast-fail | 2026-04-11 | [F004](features/F004-context-memory-authoritative.md) |
| F005 | 运行时治理 UI：权限系统 + 面板重构 + 侧边栏重做 | 2026-04-12 | [F005](features/F005-runtime-governance-ui.md) |
| F006 | UI/UX 深度重塑与运行时治理 V2 + Event Transformer + 会话隔离 | 2026-04-14 | [F006](features/F006-ui-ux-refinement-and-runtime-governance-v2.md) |
<!-- 完成的 Feature 从活跃表移到此处 -->
