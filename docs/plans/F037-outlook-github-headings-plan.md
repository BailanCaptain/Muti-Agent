# F037 Outlook GitHub Headings Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 让 Windows 经典 Outlook 中的开源榜单使用与上方正文一致的字体，并把四个榜种标题提升为与“科技从业者 / 推理”相同的独立子标题。
**Acceptance Criteria:**
- AC1：GitHub 榜单标题、序号、仓库标题、数据行和摘要均显式使用现有 `SANS` 字体栈，不依赖 Classic Outlook 跨嵌套 table 的字体继承。
- AC2：“增长榜 · 今日 / 周榜 / 新秀榜 · 7 天新仓 / 月榜”分别以现有 `subHeading` 独立渲染，格式为“榜名 · N 条”，榜单卡内部不再重复 `◆ 榜名 · N`。
- AC3：“开源榜单”总名、四榜名称、顺序、caps、仓库条目、排名状态、链接、Markdown 和 98 KiB 终态门禁不变。
- AC4：机器合同、2026-07-21 归档重放和 Chromium 截图证明结构与字体修正；Classic Outlook 最终视觉由次日真实收件观察确认。
- AC5：合入后只通过项目既有安全入口重启项目 runtime，并在次日 07:30 后检查发送账本、日报归档及所有信源健康；不重启电脑、不直接 kill 父进程、不改 `.env` 或 startup config。
**Architecture:** Preserve 模式。复用 `subHeading()` 作为所有子栏目标题的唯一 HTML 生成器；`ghListCard()` 只负责仓库列表内容。对 GitHub 嵌套文本节点补齐现有 `SANS` 内联字体，使 Word HTML 引擎不再依赖跨 table 继承；数据与排序管道不变。
**Tech Stack:** TypeScript、node:test、HTML email presentation tables、MSO conditional CSS、Playwright Chromium。

## 执行状态（2026-07-22 01:00）

- [x] AC1：GitHub 嵌套 table 与全部直接文字节点显式锁定现有 SANS。
- [x] AC2：四榜复用 `subHeading()` 独立成行，卡内旧标题已移除。
- [x] AC3：生产归档重放证明链接、展示集合、顺序、Markdown 与 98 KiB 门禁守恒。
- [x] AC4：机器合同、生产归档重放与 Playwright Outlook 结构截图已完成；真实 Classic Outlook 仍待 07:30 实收。
- [ ] AC5：待合入后受控重启项目，并由一次性监控在 07:30 后检查发送与信源。

---

### Task 1: RED — 锁定 Outlook 字体与标题层级

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.test.ts`

1. 构造同时包含增长榜和周榜的 GitHub fixture。
2. 断言每个榜种先出现 `outlook-subheading`，文案分别为“增长榜 · 今日 · N 条”“周榜 · N 条”，其后才是 `outlook-list-card`。
3. 断言榜单卡内部不再含 `◆` 榜名行。
4. 断言仓库标题、序号、meta 与摘要均显式携带现有 sans 字体栈。
5. 运行：`pnpm exec tsx --test packages/api/src/services/daily-digest/renderer.test.ts`。
6. 预期：测试因标题仍嵌在卡内、文本节点缺显式字体而失败。

### Task 2: GREEN — 复用子标题并显式锁定字体

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.ts`

1. 将 `ghListCard(kindLabel, entries, density)` 收窄为 `ghListCard(entries, density)`。
2. 删除榜单卡内部的 `◆ ${kindLabel} · ${entries.length}` 行。
3. GitHub 渲染循环先追加 `subHeading(label, entries.length, \`sub-github-${index}\`)`，再追加列表卡。
4. 给列表卡内部 table、序号、仓库链接、meta 与摘要补齐 `font-family:${SANS}`；不新造颜色、字号或字体 token。
5. 重跑专项测试到 GREEN。

### Task 3: Refactor 与回归守恒

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.test.ts`
- Update: `docs/bugReport/B039-outlook-github-headings.md`

1. 更新受影响的旧断言，从 `◆ 榜名 · N` 改为独立“榜名 · N 条”，保留四榜顺序与 cap 断言。
2. 运行 renderer、daily-digest job 与 API 相关测试。
3. 运行 typecheck、lint、build、components 和全量测试；记录任何可在 `dev` 复现的基线失败。
4. 回填 B039 六件套与 FAIL→PASS 输出。

### Task 4: 同源视觉证据

**Files:**
- Create (untracked): `.agents/acceptance/B039/before.png`
- Create (untracked): `.agents/acceptance/B039/after.png`
- Create (untracked): `.agents/acceptance/B039/report.md`

1. 用生产形态 fixture 生成改前/改后 HTML；渲染 600px 桌面截图。
2. 量化比较子标题数量、字体声明、外链顺序、显示条目、HTML 字节与 98 KiB 门禁。
3. 启动 worktree preview，确认隔离端口与验收目录可用；不把证据提交进 Git。

### Task 5: 门禁、验收、review 与运行观察

1. 加载 `quality-gate`，输出 spec/愿景合规与验证命令结果。
2. 由零上下文 `acceptance-guardian` 独立验收，再由 peer reviewer 审查 diff；P1/P2 走 RED→GREEN 闭环。
3. 按 `merge-gate` 合入 `dev` 后，使用仓库已有的项目安全重启入口；若不存在或会 kill 当前父进程则 fail-closed，留下人工操作说明。
4. 创建一次性次日监控：07:30 后核对当日 archive、sent/outbound ledger、X 板块和全部 source-health，发现失败时报告 sourceId 与原始 errorKind，不自动补发或改配置。
