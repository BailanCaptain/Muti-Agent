# F037 RSSHub Direct Transport Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 全局代理启用时，本机 RSSHub 的 X 抓取仍通过已有直连 client 到达 `localhost:1200`。
**Acceptance Criteria:** loopback RSSHub X 使用 `httpDirect`；无直连 client 时兼容现有 `http`；远端自建 RSSHub 与 TwitterAPI.io 继续使用代理 client；不修改 `.env`、Cookie、Docker 配置，不补发今天日报。
**Architecture:** 复用 `SourceFetchContext.httpDirect`，把它沿 `makeXSource → XProvider.fetchHandles` 传入。RSSHub provider 仅对 loopback origin 选择 direct，外部 origin/provider 保持 `http`。
**Tech Stack:** TypeScript、Node test、pnpm workspace。

---

## Straight-Line Check

- **Finish line：** proxy client 故障而 direct client 正常时，RSSHub X 仍产出条目；外部 API 不误走 direct。
- **Terminal schema：** `XProvider.fetchHandles` context 增加可选 `httpDirect?: SafeHttpClient`，不新增临时适配层。
- **不做：** 不改用户配置、鉴权 Cookie、RSSHub 容器生命周期或发送账本。

### Task 1: RED — 锁定 transport 选择

**Files:**
- Test: `packages/api/src/services/daily-digest/sources/x-provider.test.ts`

1. 添加组合测试：`http` 抛代理错误、`httpDirect` 返回有效 RSS。
2. 通过 `makeXSource(...).fetch(...)` 调用真实 provider。
3. 运行 `pnpm --filter @multi-agent/api test -- x-provider.test.ts`。
4. 期望旧实现因调用 proxy client 而失败，并记录失败输出。

### Task 2: GREEN — 复用既有 direct client

**Files:**
- Modify: `packages/api/src/services/daily-digest/sources/x-provider.ts`

1. 给 provider context 增加 `httpDirect?: SafeHttpClient`。
2. `makeXSource` 传递 `ctx.httpDirect`。
3. RSSHub provider 仅在 base 为 loopback origin 时使用 `ctx.httpDirect`；远端 RSSHub 与 TwitterAPI.io 不变。
4. 运行 Task 1 测试，期望 PASS。
5. 增加/确认远端 RSSHub 与 TwitterAPI.io 保持调用 `ctx.http` 的边界测试。

### Task 3: 回归与交付

**Files:**
- Modify: `docs/bugReport/B040-rsshub-proxy-routing.md`
- Modify: `docs/features/F037-daily-news-digest.md`

1. 跑 X provider、orchestrator、daily-digest job 相关测试。
2. 跑 API typecheck、lint 和质量门禁要求的验证。
3. 更新 B040 六件套与 F037 Timeline。
4. 独立验收、peer review 后合入 `dev`。
5. 仅重启 Multi-Agent 项目 API；不重启电脑、不重启 RSSHub、不补发日报。
