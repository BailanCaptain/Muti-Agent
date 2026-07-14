# Multi-Agent Feature Roadmap

> **用途**：Feature 追踪索引表。每个 Feature 立项时在此注册，完成后移至「已完成 」表。
> **聚合文件**：每个 Feature 的详细 spec 在 `docs/features/Fxxx-name.md`。

## 活跃 Features

| ID | 名称 | 状态 | Owner | Source | Spec |
|----|------|------|-------|--------|------|
| F017 | 跨房间协作感知：侧边栏运行指示 + 全局任务状态 | spec | 桂芬 | internal | [F017](features/F017-cross-room-awareness.md) |
| F020 | 决策卡片挂载矩阵：按场景分流（单 agent 消息内嵌 / 链级 Footer / 多人讨论收敛后弹）+ 折叠徽章 + 吸收 B007 | spec | 黄仁勋 | internal | [F020](features/F020-decision-card-mounting-matrix.md) |
| F029 | 调研与核查管道：fact-check + deep-research 双模式（统一检索层 + 异质 agent 两阶段独立验证 + 证据账本 + 四字段裁决 + 引用溯源 + 搜索条入口） | spec | 黄仁勋 | internal | [F029](features/F029-research-verification-pipeline.md) |
| F032 | SOP 谓词执行器·审计模式：规则谓词化 + 违规审计报告，只报不拦（借鉴批次 3/6） | spec | 黄仁勋 | internal | [F032](features/F032-sop-predicate-audit.md) |
| F034 | SOP 谓词硬拦截·确定性边界：WorkflowSop 流转/merge gate/MCP 操作（借鉴批次 5/6，Blocked by F032） | spec | 黄仁勋 | internal | [F034](features/F034-sop-predicate-enforcement.md) |
| F041 | 投研跟踪台（invest-tracker）：watchlist 实体层（A股新易盛/中际旭创/天孚通信/亨通光电/东山精密 + 美股康宁/英伟达/美光 + 光模块/CPO/光纤板块）+ 公告/研报/评级动作 source-of-record（巨潮+东财+EDGAR，Yahoo 评级个人用途启用）+ 双管线（invest-ingest 小时抓 / invest-delivery 08:00 简报）+ SQLite 真相源+Obsidian 投影 + 与 F027/F037 全隔离（合同五条+三层测试）。德彪 r1+r2 双轮对抗审收敛蓝图 v2；解耦施工中（小孙 07-10 拍）：Phase A 零 F037 交集件（建表/归一/四源解析 fixture/日历/投影/隔离测试）在 .worktrees/F041 推进+德彪中间审收敛中，Phase B（纯移动抽零件→HTTP/邮件/账本接线）GATED on F037 合并 | spec | 黄仁勋 | internal | [F041](features/F041-invest-research-tracker.md) |
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
| F031 | WS 消息可靠性：per-sessionGroup seq + 进程 epoch（仅 broadcast 咽喉注入）+ 快照水位线（read-before-build）+ delta offset 幂等（三 emit 源 + segment 队列 flush 时刻判定）+ StreamMonitor gap 检测/catch-up（debounce/降级/`[F031:ws-gap]` 结构化日志）+ subscribe-before-fetch + pending 对账。丢事件从玄学变一行日志+自愈。德彪设计审 r1→r3 + 代码审 r4→r6 GO（5 真洞全在双路径交错窗口），43 新用例。小孙拍板收口 | 2026-07-03 | [F031](features/F031-ws-message-reliability-seq-epoch.md) |
| F033 | 交互卡片（C2）：select/multi_select/confirm 三 kind（request_decision 轨升级，非 cc_rich 新 kind）+ decision_records 生命周期持久化（幂等门/boot orphan/已决卡 disabled 留痕渲染，刷新重启不丢）+ confirm 超时 fail-closed + respond 运行时校验 + 审计留痕带上下文 + 中文 IME isComposing 守卫（含 composer 同族缺陷）+ anchorMessageId 断线修复。德彪 r1→r2 GO + guardian PASS + 小孙活体验收（squash 77274c1） | 2026-07-03 | [F033](features/F033-interactive-cards.md) |
| F038 | 前端 E2E 自动化测试基建：Playwright 真点击验证前后端交互（@playwright/test@1.59.1 + 隔离 harness：os.tmpdir 临时 SQLite/专用端口 3999/8999/reuse:false/scheduler kill-switch + Iron Law fail-closed 护栏）+ 3 种子用例（新建全链路 POST id→testid 锚点→后端独立断言/搜索 fill/冷启动+WS）+ webapp-testing skill（/e2e·侦察后行动/验红纪律）+ quality-gate「E2E 首选」/acceptance-guardian「无浏览器级证据判❌」接线 + CI e2e job（非阻塞起步 TD-F038-1）。德彪设计审 r1→代码审 r2→r3 GO + 零上下文 guardian PASS 10/10（单 squash 合 dev，F025 YAGNI 项补齐；参考 testdino playwright-skill + anthropics webapp-testing） | 2026-07-03 | [F038](features/F038-frontend-e2e-testing-infra.md) |
| F039 | 前端视觉打磨 pass：三参考规范对标（google design.md / taste-skill / ui-ux-pro-max）——16 股票 hue 族→6 OKLCH 暖调和族 config 重映射（642 处裸冷色零改名收编 + gray/zinc/stone 收编暖灰）+ 字阶 token 299 处 snap 清零 + 全局 focus-visible 焦点环 + 系统 CTA 归位 accent/按压反馈 + 65+ 结构 emoji→lucide + SkeletonLines/reduced-motion + 空房间欢迎名册卡 + repo 根 DESIGN.md 设计真相源。quality-gate 全绿 + guardian PASS + 范德彪 r1 GO（0 findings）+ 小孙验收「非常」（squash 5ec9c1d） | 2026-07-03 | [F039](features/F039-visual-polish-pass.md) |
| F040 | 外部 IM 渠道网关（飞书 WS 长连接免公网）+ 手机端 PWA 私有组网：入站双门（p2p open_id 白名单 / 群双白名单+@bot+owner 裸媒体旁路）+ lazy binding（SQLite 真相源）+ 命令面自助六命令 + 占位卡状态机（PATCH 变身/分段保序/sweeper）+ 双向图文件（入站落盘注入 + send_file MCP 工具出站）+ 渠道管理页 + SafeHttpClient 合同对齐 + PWA 生产构建。德彪八轮审收敛（P1/P2/P2.5/P2.6/P3 r1→GO + T7 终审 r7 NEEDS-WORK 1P1+3P2→修8~11 红先→r8 GO 零新洞）+ 小孙真机全链验收（私聊图文双向/群图 owner/出站文件/PWA 数据）。squash `48aaa4e` + 主运行时收尾 4 修（dist 补建 `a7f64fb`/手机生产构建 `f34cdc8`/CORS .env 加载 `e31b773`/构建检查 git 化 `66d5678`）全 push origin/dev | 2026-07-10 | [F040](features/F040-im-channel-gateway.md) |
| F043 | Token 用量口径修复 + 上下文可观测：封存假阳性根治（三症状一根因=三家 adapter 把累计计费当上下文占用：claude result 求和永远最后到 + codex cached⊆input 双计 + 窗口表 opus-4-8 落 200k）——P0 四刀（双语义 scope 路由/rollout 回读/窗口解析/封存复位）+ P1 四件（七列持久化/MessageMeta 胶囊/面板真值直传/轮中 usage.snapshot）+ AC9 测试口径翻正（真实探针语料）。quality-gate 四层对账 57,053 精确一致 + 零上下文 guardian PASS + 德彪三轮收敛（r1 3P1→修1→r2 1残留→修2→r3 GO）+ 小孙活体验收（足迹五连增累加实锤）。squash `4282172` push origin/dev；随验收发现「轮反馈死区 ~13.7s」定为独立 BUG 待修 | 2026-07-11 | [F043](features/F043-token-accounting-fix.md) |
| F044 | 会话切换即时反馈 + 长会话按需加载：pending 即时选中/手机抽屉即关 + 最新 100 条稳定游标分页 + 阅读锚点 + minimap 120 上限/统计单扫；A→B→A stale success/error/finally 与 loading ownership 竞态经 Red→Green + TAKEOVER 收口。全量 API/脚本 4046、组件 845、Playwright 真 SQLite 3/3；Guardian PASS + Claude 最终 GO + 小孙 preview 确认。squash `ba3fb84` push origin/dev | 2026-07-11 | [F044](features/F044-session-switch-performance.md) |
| F042 | 记忆消费闭环一期：direct_turn shadow 召回（三态开关默认影子 + shadow 异步化）+ 采纳度量（prompt_audit 扩列 + /api/recall/stats + 观察窗小结卡/rerank 标注级联卡）+ canonical 生命周期（同源强制 supersede 事件账本真相源 + 旧版退召回面 + NHC 排 _superseded 噪音）+ 编译候选喂料（pre-compile 接 wiki_entity_index + sources.path 进 prompt）+ 外部守活探针（schtasks 20min + 维护模式）+ AC6 召回快链（ADR-005：查询编译器 CJK 三字滑窗 + 本地 evidence gate 去同步 LLM + miss 不进 L5 + 500ms fail-open；中文自然句 28-60s 恒空→47-86ms 真命中，p95=86ms）。主线批+AC6 批德彪各三轮审+§17 TAKEOVER 双闭环 + guardian 双批 PASS + 小孙 UI 验收（audit #70 命中 80ms/#69 真空 76ms）。沉淀 ADR-005 + LL-035/036/037 | 2026-07-12 | [F042](features/F042-memory-consumption-loop.md) |
| F037 | 日报邮件推送系统（DailyBrief）：每日 07:30 中文 HTML 日报（AI/社区动态/今日热点/GitHub/播客五板块，40 路信源+X 35 账号+小宇宙 8 播客+YouTube 12 频道）+ LLM 三层质量（diversify 喂样→精选/跨源合并/分栏 tag→两段式深读）+ 播客 STT 转写（硅基流动）+ YouTube 字幕深读（cookies 提权/429 退避/无字幕摘除门/24h 延迟窗）+ B032 证据化编辑门（正常双 Claude 独审、固定 Codex 裁争议；Claude 全挂时 Codex clean-room A/B/C 且明示同模型降级，Composer 只见获批原文）+ B033 首发可靠性（5–8 条速览终态门禁、YouTube 瞬时状态单次受控重试、2026-07-15 正式去重 epoch）+ 失败治理（宁缺勿发+整点安全网+播客整源 96h 极宽保险丝+含慢模型链最坏账 778350s / watchdog 1209600s）+ 跨日已见账本/政治与未成年人防护滤/字节预算自动降密度 + BCC 密送 SMTP 直发（deadline+closeOnce 全终态）+ 网页版归档与设置页 + 出站白名单/外发账本。邮件格局、原有文案、“开源榜单”及 GitHub 四组语义保持不变；2026-07-15 07:30 定为首封正式日报，实际成功发布项从次日起参与去重 | 2026-07-14 | [F037](features/F037-daily-news-digest.md) |
<!-- 完成的 Feature 从活跃表移到此处 -->
