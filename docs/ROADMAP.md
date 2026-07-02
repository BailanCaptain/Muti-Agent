# Multi-Agent Feature Roadmap

> **用途**：Feature 追踪索引表。每个 Feature 立项时在此注册，完成后移至「已完成 」表。
> **聚合文件**：每个 Feature 的详细 spec 在 `docs/features/Fxxx-name.md`。

## 活跃 Features

| ID | 名称 | 状态 | Owner | Source | Spec |
|----|------|------|-------|--------|------|
| F017 | 跨房间协作感知：侧边栏运行指示 + 全局任务状态 | spec | 桂芬 | internal | [F017](features/F017-cross-room-awareness.md) |
| F020 | 决策卡片挂载矩阵：按场景分流（单 agent 消息内嵌 / 链级 Footer / 多人讨论收敛后弹）+ 折叠徽章 + 吸收 B007 | spec | 黄仁勋 | internal | [F020](features/F020-decision-card-mounting-matrix.md) |
| F029 | 调研与核查管道：fact-check + deep-research 双模式（统一检索层 + 异质 agent 两阶段独立验证 + 证据账本 + 四字段裁决 + 引用溯源 + 搜索条入口） | spec | 黄仁勋 | internal | [F029](features/F029-research-verification-pipeline.md) |
| F031 | WS 消息可靠性：sessionGroup seq + epoch + gap 检测/catch-up（借鉴批次 2/6） | in-progress | 黄仁勋 | internal | [F031](features/F031-ws-message-reliability-seq-epoch.md) |
| F032 | SOP 谓词执行器·审计模式：规则谓词化 + 违规审计报告，只报不拦（借鉴批次 3/6） | spec | 黄仁勋 | internal | [F032](features/F032-sop-predicate-audit.md) |
| F033 | 交互卡片：select/confirm 选择块，结构化响应保留（借鉴批次 4/6，Blocked by F030，Related F020） | spec | 黄仁勋 | internal | [F033](features/F033-interactive-cards.md) |
| F034 | SOP 谓词硬拦截·确定性边界：WorkflowSop 流转/merge gate/MCP 操作（借鉴批次 5/6，Blocked by F032） | spec | 黄仁勋 | internal | [F034](features/F034-sop-predicate-enforcement.md) |
| F037 | 日报邮件推送系统（DailyBrief）：每日 07:30 五板块中文 HTML 日报（AI 推理/训练加权 + 热点 + 篮球/电竞 + 股票）+ 周一 GitHub 周榜 + LLM 速览摘要 + 单源失败隔离 + 出站白名单/外发账本 | spec | 黄仁勋 | internal | [F037](features/F037-daily-news-digest.md) |
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
| F012 | 前端加固 + 渲染重构 + DesignSystem + 三 CLI 整改 + 截图能力：消息卡片化 + 折叠式展示 + 统一设计 + CLI 参数/事件对齐 clowder-ai + Puppeteer 截图 | 2026-04-15 | [F012](features/F012-frontend-hardening-redesign.md) |
| F008 | 开发基础设施 + 视觉证据链：Hot-Reload + ImageBlock + 日志 + 截图 | 2026-04-14 | [F008](features/F008-dev-infra-evidence-chain.md) |
| F013 | CI/CD 门禁：GitHub Actions + pre-commit hook + 文档状态校验 | 2026-04-14 | [F013](features/F013-ci-cd-gate.md) |
| F011 | 后端加固 + drizzle-orm 迁移：数据库/WS/事件健壮性 + ORM 一步到位 | 2026-04-15 | [F011](features/F011-backend-hardening-drizzle.md) |
| F019 | Skill 告示牌机制：WorkflowSop 状态机 + sopStageHint 注入 + update-workflow-sop callback 替换 prependSkillHint 关键词注入层（对齐 clowder-ai F073 P4） | 2026-04-17 | [F019](features/F019-skill-bulletin-board.md) |
| F018 | 上下文续接架构重建：对齐 clowder-ai 冷存储 + SessionBootstrap + embedding 作为 recall 后端（F007 架构级收尾，修复 B015/B012 根因） | 2026-04-18 | [F018](features/F018-context-resume-rebuild.md) |
| F023 | 三家 MCP 挂载统一（对齐 clowder-ai）+ 弃 CALLBACK_API_PROMPT | 2026-04-20 | [F023](features/F023-mcp-unified-mounting.md) |
| F024 | Worktree 愿景验收基础设施（L1 preview + L2 临时集成 worktree + Dogfooding） | 2026-04-20 | [F024](features/F024-worktree-vision-acceptance-infra.md) |
| F025 | 前端单测基础设施：vitest + @testing-library/react + happy-dom + `pnpm test:components` + 示例测试 + 速查文档 | 2026-04-20 | [F025](features/F025-frontend-unit-test-infra.md) |
| F022 | 左侧 Sidebar 重设计：全局递增 ROOM ID (R-001) + Haiku 自动命名 + 反向溯源 + 右键菜单四件套 | 2026-04-21 | [F022](features/F022-left-sidebar-redesign.md) |
| F021 | 右侧面板重设计 — 观测带 + 智能体列表 + 两级配置（全局默认/会话专属）+ Side-Drawer + Phase 6 上下文窗口/Seal 阈值齿轮可配 + fillRatio 观测 + seal 感知（first_completed 2026-04-21 / reopened 2026-04-22 / recompleted 2026-04-26）| 2026-04-26 | [F021](features/F021-right-panel-redesign.md) |
| F026 | A2A 可靠通信层 v2（Round 2 · Call Tree + Envelope 双层 + 协议透明 + 十一条不变量）：mention-router 三层 fail-closed + on-behalf 语义反推 + Worklist 树形续推 + 方案 X `[Call:]` 强契约 + retry-guard + cold-target burst 兜底 + 前端栏（溯源胶囊/折叠/墓碑/Pulse/淡紫色）。ADR-002/003/004 落盘。Supersedes F015 / Evolved from F003。DoD-1/2/3 全绿（小孙 2026-05-08 真机验场景 1/3 通过） | 2026-05-08 | [F026](features/F026-a2a-reliability-layer.md) |
| F030 | Rich Blocks 只读卡片协议（C1）：内联 cc_rich 单轨（card tone/fields + checklist）+ agent 发送通道 + Zod fail-closed + rich-messaging skill + 摘要零泄漏（stripRichFencesForPreview · clowder-ai 借鉴批次 1/6）| 2026-06-14 | [F030](features/F030-rich-blocks-readonly-cards.md) |
| F028 | RuntimeLog 工作区拓展：项目目录浏览 + Worktree 浏览/手动编译（主线 AC1-10）+ **续作 worktree 清理 MVP**（AC11 列表合并状态 + AC12 一键清理/清完即时消失）。AC13 脱管 takeover + OQ9 零点击 auto-cleanup 待小孙拍 | 2026-06-14 | [F028](features/F028-workspace-explorer-tabs.md) |
| F027 | 统一记忆架构（V16.5 整套）：三层 wiki + wiki_events 事件源（ACL/CAS/lease/fencing）+ 6 类记忆桶（文件真相源）+ memory_preflight 自动召回 + Adaptive Recall 5 级 fallback + viewfinder 防漂 ledger + 11 调度 jobs + RuntimeLog 5-tab（取景器/Inspector/审批/警告/KB）+ IngestModal/promote 审批全链 + V14 LLM 语义判官 + docs-watcher/backfill 收录。残债：月度纠错待武装（C1.5 下轮专做）+ B/C 长尾见 RESIDUAL-DEBT | 2026-06-15 | [F027](features/F027-unified-memory-architecture.md) |
| F036 | 前端 Notion/clowder 风 restyle（OKLCH token + 4 档表面高度 + 暖中性/暖金 accent）+ 前端审计收口 11 项（删死链/进度条对齐封存阈值/封存阈值改名/圆角 token 统一/xhigh+effort 白名单/删死代码/cli-output 删孤儿/三「下一轮」语义/长会话导航 D 标记轨/rich 卡型 table+progress/restyle 测试债）。范德彪 r1→r2 GO + 小孙活体验收通过 | 2026-07-02 | [F036](features/F036-notion-restyle.md) |
| F035 | 前端加载性能：bundle 基线实测（首屏 313.8 KiB gzip / 底座 147 不可分割）+ 400 KiB 预算门脚本（measure-first-load.mjs 零依赖 + 假绿 fail-fast）+ AC4 合法提前 close（localhost 分割收益 7-19% 体感为零，三条重开触发器）。D0 ignoreBuildErrors 独立先合。德彪 r1→r2 CONFIRMED-GO | 2026-07-03 | [F035](features/F035-frontend-load-performance.md) |
<!-- 完成的 Feature 从活跃表移到此处 -->
