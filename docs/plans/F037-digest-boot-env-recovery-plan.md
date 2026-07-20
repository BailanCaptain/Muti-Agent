# F037 Digest Boot Environment Recovery Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** API 无论由正式 bat 还是直接 `tsx` 启动，都能只读根 `.env` 的日报前缀、稳定注册 F037，并在禁用时留下不泄密的原因码。
**Acceptance Criteria:**
- AC1: 进程环境缺少日报变量、根 `.env` 配齐时，日报启用门为真；非 `MULTI_AGENT_DIGEST_*` 变量绝不导入。
- AC2: 进程环境按键存在即覆盖文件，空值与 `MULTI_AGENT_DIGEST_ENABLED=0` 均可 fail-closed；显式 `=1` 保持强开。
- AC3: 同一解析后环境传给 enable gate、`bootDailyDigest`、scheduler fallback 与 settings route，不能出现“任务注册但 sender 退化 mock”。
- AC4: 禁用日志只输出固定原因码/缺失键，不输出 SMTP 用户、密码、收件人或代理值。
- AC5: 合入并精确重启后，startup reconcile 为 2026-07-20 生成归档并按正式收件人清单只发送一次，账本终态为 `sent`。
**Architecture:** 在 `daily-digest/boot.ts` 增加纯只读的前缀解析与 enablement decision；server 和 scheduler 从各自明确的 `rootDir/.env` 取得同一快照并显式传递。保留 `process.env` 优先级、显式关闭及现有 reconcile/ledger 单入口。
**Tech Stack:** TypeScript、Node `fs`、Fastify、node:test、现有 SchedulerRuntime/F037 ledger。

---

## Straight-Line Check

- **终点**：重启后的生产 scheduler 显示 `9 cron/2 startup`，startup reconcile 完成 2026-07-20 的一次正式发送。
- **不做**：不改 `.env`，不全量加载 dotenv，不新建第二套 sender/调度器，不旁路 ledger，不修改邮件内容与版式。
- **终态接口**：`resolveDigestBootEnv(processEnv, dotenvPath)`、`evaluateDigestEnablement(env, loadSettings)`；调用方显式传递同一 `env`。

### Task 1: RED — 前缀环境与启用原因合同

**Files:**
- Modify: `packages/api/src/services/daily-digest/boot.test.ts`
- Test: `packages/api/src/services/daily-digest/boot.test.ts`

1. 写失败测试：临时 `.env` 含日报凭证/收件人、`CORS_ORIGIN`、带引号及含 `=` 的值；断言只导入日报前缀且不改入参/`process.env`。
2. 写失败测试：进程 `ENABLED=0`、空 SMTP user 按键覆盖文件；完整文件可启用。
3. 写失败测试：`evaluateDigestEnablement` 返回 `explicit_off/explicit_on/smtp_ready/missing_user/missing_pass/missing_recipient` 固定原因码。
4. 运行：`pnpm exec tsx --test packages/api/src/services/daily-digest/boot.test.ts`；预期因新导出不存在而 RED。

### Task 2: GREEN — 最小前缀解析与 enablement decision

**Files:**
- Modify: `packages/api/src/services/daily-digest/boot.ts`

1. 实现 `resolveDigestBootEnv`：只读明确路径、仅 `MULTI_AGENT_DIGEST_*`、支持 BOM/注释/成对引号/首个等号切分；文件错误 fail-soft。
2. 实现 `evaluateDigestEnablement`，让 `isDigestEnabled` 成为兼容 boolean wrapper；任何原因都不携带值。
3. `bootDailyDigest` 仅在未显式注入 `opts.env` 时解析 `rootDir/.env`。
4. 重跑 Task 1；预期 GREEN。

### Task 3: RED→GREEN — 生产装配同源

**Files:**
- Modify: `packages/api/src/server.ts`
- Modify: `packages/api/src/runtime/scheduler-bootstrap.ts`
- Modify: `packages/api/src/runtime/scheduler-bootstrap.test.ts`

1. 写/扩测试锁定：解析后的完整 `.env` decision 为 enabled；注入 runtime 仍注册 2 个 digest cron + startup；显式关闭保持 `7/1`。
2. server 只解析一次，使用 decision 建 runtime，并把同一 env 传给 `bootDailyDigest` 与 `registerDailyDigestRoutes`；disabled 时记录固定原因码。
3. scheduler fallback 用 `rootDir/.env` 的同一解析规则并把 env 传给 `bootDailyDigest`。
4. 运行 boot/scheduler/routes 定向测试；预期 GREEN。

### Task 4: 质量、验收与合入

**Files:**
- Modify: `docs/bugReport/B038-digest-boot-env-disabled.md`
- Modify: `docs/features/F037-daily-news-digest.md`

1. 运行定向测试、`pnpm typecheck`、`pnpm test`、`pnpm build`。
2. quality-gate 对照 F037 AC1/D10/D11/D13；生成本地证据。
3. acceptance-guardian 零上下文复验，再请求 peer review；处理所有 P1/P2。
4. 合入 `dev`，更新 B038 状态与 F037 Timeline。

### Task 5: 精确重启与一次补发

1. 重启前解析 8787/3000 listener PID、命令行和 CreationDate，只停止已验证属于本仓库的 API/Web 进程树；不调用会扫 3001 的宽泛停止脚本。
2. 以隐藏进程、根目录工作路径和只读 `.env` 子进程环境启动 API/Web。
3. 核对日志 `9 cron/2 startup`、daily-digest startup trace 与当日归档。
4. 只认现有 reconcile/ledger；若 startup 已发送，禁止再调用 send-now。核对 2026-07-20 `sent`、outbound ledger 仅新增一行及正式收件人数。
