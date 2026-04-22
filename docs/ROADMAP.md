# Multi-Agent Feature Roadmap

> **用途**：Feature 追踪索引表。每个 Feature 立项时在此注册，完成后移至「已完成 」表。
> **聚合文件**：每个 Feature 的详细 spec 在 `docs/features/Fxxx-name.md`。

## 活跃 Features

| ID | 名称 | 状态 | Owner | Source | Spec |
|----|------|------|-------|--------|------|
| F012 | 前端加固 + 渲染重构 + DesignSystem + 三 CLI 整改 + 截图能力：消息卡片化 + 折叠式展示 + 统一设计 + CLI 参数/事件对齐 clowder-ai + Puppeteer 截图 | in-progress | 黄仁勋 | internal | [F012](features/F012-frontend-hardening-redesign.md) |
| F017 | 跨房间协作感知：侧边栏运行指示 + 全局任务状态 | spec | 桂芬 | internal | [F017](features/F017-cross-room-awareness.md) |
| F020 | 决策卡片挂载矩阵：按场景分流（单 agent 消息内嵌 / 链级 Footer / 多人讨论收敛后弹）+ 折叠徽章 + 吸收 B007 | spec | 黄仁勋 | internal | [F020](features/F020-decision-card-mounting-matrix.md) |
| F026 | A2A 可靠通信层：六条不变量 + 14 症状回归 + worklist 续推 + a2aFrom/triggerMessageId + burst/Tombstone + callback token TTL（抄 clowder 七件、修三处抄错、Day1 前端并发@）Supersedes F015, Evolved from F003 | spec | 黄仁勋 | internal | [F026](features/F026-a2a-reliability-layer.md) |
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
| F018 | 上下文续接架构重建：对齐 clowder-ai 冷存储 + SessionBootstrap + embedding 作为 recall 后端（F007 架构级收尾，修复 B015/B012 根因） | 2026-04-18 | [F018](features/F018-context-resume-rebuild.md) |
| F023 | 三家 MCP 挂载统一（对齐 clowder-ai）+ 弃 CALLBACK_API_PROMPT | 2026-04-20 | [F023](features/F023-mcp-unified-mounting.md) |
| F024 | Worktree 愿景验收基础设施（L1 preview + L2 临时集成 worktree + Dogfooding） | 2026-04-20 | [F024](features/F024-worktree-vision-acceptance-infra.md) |
| F025 | 前端单测基础设施：vitest + @testing-library/react + happy-dom + `pnpm test:components` + 示例测试 + 速查文档 | 2026-04-20 | [F025](features/F025-frontend-unit-test-infra.md) |
| F022 | 左侧 Sidebar 重设计：全局递增 ROOM ID (R-001) + Haiku 自动命名 + 反向溯源 + 右键菜单四件套 | 2026-04-21 | [F022](features/F022-left-sidebar-redesign.md) |
| F021 | 右侧面板重设计：观测带 + 智能体列表 + 两级配置（全局默认/会话专属）+ Side-Drawer + 运行中挂起到下一轮 + pill resolved snapshot | 2026-04-21 | [F021](features/F021-right-panel-redesign.md) |
<!-- 完成的 Feature 从活跃表移到此处 -->
