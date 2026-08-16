# B047 Runtime API Host Routing Implementation Plan

**Bug:** B047 — `docs/bugReport/B047-runtime-api-host-routing.md`
**Goal:** Web 与 API 同机部署时，浏览器始终按当前页面 hostname 访问 API/WS，同时保留配置的协议、端口和路径。
**Acceptance Criteria:**
- AC9: API `take_screenshot` / `send_file` persist and broadcast root-relative internal `/uploads/...` block URLs while their callback responses remain absolute for compatibility.
- AC7: Internal `/uploads` image/file resources use the page hostname and configured API port; external media URLs are unchanged.
- AC8: The poisoned-host E2E fails when HTTP consumers regress, by asserting `/api/bootstrap` hostname, port, success, and session UI.
- AC1: `localhost` 页面会把构建时 Tailscale API/WS host 重写为 `localhost`。
- AC2: Tailscale/LAN 页面会把 preview 的 `localhost` host 重写为当前页面 host，并保留 preview API 端口。
- AC3: SSR/无浏览器环境保持构建时配置原值。
- AC4: 浏览器端不再直接读取 `process.env.NEXT_PUBLIC_API_*`，统一走单一解析器。
- AC5: 生产构建 + 真实浏览器显示“实时连接成功”，API 记录 WebSocket client connected。
- AC6: 相关单测、全量测试、typecheck、build 通过。
**Architecture:** 新建 `lib/api-endpoints.ts` 作为公开 API URL 单一真相源。配置 URL 决定协议、端口和路径；浏览器 `window.location.hostname` 决定运行时 host；SSR 保持配置值。所有 browser-side HTTP/WS 调用迁移到该模块。
**Tech Stack:** TypeScript、Vitest、Next.js 16、WebSocket、Playwright/真实浏览器。

---

### Task 1: URL 解析契约

**Files:**
- Create: `lib/api-endpoints.test.ts`
- Create: `lib/api-endpoints.ts`

1. 写测试覆盖 localhost、Tailscale、preview 端口、SSR 四类行为。
2. 运行 `pnpm vitest run lib/api-endpoints.test.ts`，确认因模块缺失而失败。
3. 写最小 `resolveApiUrl(configuredUrl, runtimeHostname)` 实现。
4. 重跑测试确认通过。

### Task 2: 浏览器消费者迁移

**Files:**
- Modify: `components/ws/client.ts`
- Modify: `components/stores/*.ts` 中所有 `NEXT_PUBLIC_API_*` 直接读取
- Modify: `components/chat/**/*.ts(x)` 中所有 `NEXT_PUBLIC_API_*` 直接读取
- Modify: `components/digest/*.tsx`、`components/preview/*.ts(x)` 中所有直接读取
- Modify: `app/digest/page.tsx`、`app/debug/a2a/page.tsx`

1. 每类消费者先补/更新现有测试，证明编译时 host 会导致错误目标。
2. 改用 `getApiHttpBaseUrl()` / `getApiWebSocketUrl()`。
3. 运行 `rg 'process\.env\.NEXT_PUBLIC_API_' app components lib --glob '!lib/api-endpoints.ts'`，预期零命中。
4. 运行 `pnpm run test:components`，预期通过。

### Task 3: 回归与生产验收

1. 运行 `pnpm typecheck`，预期 0 error。
2. 运行 `pnpm test`，预期全绿。
3. 运行 `pnpm build`，预期成功。
4. 启动该 worktree L1 preview，真实浏览器验证首页实时连接。
5. 回填 B047 六件套与证据。
6. 按项目签名规则提交独立 commit。

### TAKEOVER follow-up: API producer write boundary

1. Extract the two production callbacks behind a testable factory that `server.ts` actually injects into `registerCallbackRoutes` without changing behavior.
2. Add failing tests proving screenshot/file persisted and broadcast blocks are incorrectly configured-host absolute while callback responses are absolute.
3. Keep callback response URLs absolute, but persist and broadcast root-relative `/uploads/...` block URLs.
4. Run the focused API suite, full API suite, typecheck, build, and lint; hand off to a separate reviewer without staging or committing.
