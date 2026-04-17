# Multi-Agent Feature Roadmap

> **用途**：Feature 追踪索引表。每个 Feature 立项时在此注册，完成后移至「已完成 」表。
> **聚合文件**：每个 Feature 的详细 spec 在 `docs/features/Fxxx-name.md`。

## 活跃 Features

| ID | 名称 | 状态 | Owner | Source | Spec |
|----|------|------|-------|--------|------|
| F012 | 前端加固 + 渲染重构 + DesignSystem + 三 CLI 整改 + 截图能力：消息卡片化 + 折叠式展示 + 统一设计 + CLI 参数/事件对齐 clowder-ai + Puppeteer 截图 | in-progress | 黄仁勋 | internal | [F012](features/F012-frontend-hardening-redesign.md) |
| F015 | 调度状态持久化：DispatchOrchestrator 关键 Map 写入 DB + 进程重启恢复 | spec | TBD | internal | [F015](features/F015-dispatch-state-persistence.md) |
| F017 | 跨房间协作感知：侧边栏运行指示 + 全局任务状态 | spec | 桂芬 | internal | [F017](features/F017-cross-room-awareness.md) |
| F018 | 上下文续接架构重建：对齐 clowder-ai 冷存储 + SessionBootstrap + embedding 作为 recall 后端（F007 架构级收尾，修复 B015/B012 根因） | in-progress | 黄仁勋 | internal | [F018](features/F018-context-resume-rebuild.md) |
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
| F007 | 上下文压缩优化：Microcompact + SOP书签 + 自动续接 + 动态预算 + 语义检索 | 2026-04-14 | [F007](features/F007-context-compression-optimization.md) |
| F009 | 全链路性能优化：SQLite 查询治理 + 增量快照 + 前端减压 | 2026-04-14 | [F009](features/F009-perf-optimization.md) |
| F010 | 基线回绿 + P0 止血：typecheck/test 全绿 + 崩服务级 bug 修复 | 2026-04-14 | [F010](features/F010-baseline-greenlight.md) |
| F008 | 开发基础设施 + 视觉证据链：Hot-Reload + ImageBlock + 日志 + 截图 | 2026-04-14 | [F008](features/F008-dev-infra-evidence-chain.md) |
| F013 | CI/CD 门禁：GitHub Actions + pre-commit hook + 文档状态校验 | 2026-04-14 | [F013](features/F013-ci-cd-gate.md) |
| F011 | 后端加固 + drizzle-orm 迁移：数据库/WS/事件健壮性 + ORM 一步到位 | 2026-04-15 | [F011](features/F011-backend-hardening-drizzle.md) |
| F019 | Skill 告示牌机制：WorkflowSop 状态机 + sopStageHint 注入 + update-workflow-sop callback 替换 prependSkillHint 关键词注入层（对齐 clowder-ai F073 P4） | 2026-04-17 | [F019](features/F019-skill-bulletin-board.md) |
<!-- 完成的 Feature 从活跃表移到此处 -->
