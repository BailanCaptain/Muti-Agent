## Review Request

Review-Target-ID: callback-identity-snapshot
Branch: dev

### Original Requirements

Source: thread-context on 2026-03-21

> "用户能在任何时刻终止整个链吗？你的 cancel 机制覆盖了所有路径吗？"
> "前端什么时候解锁输入框？有没有可能'看起来完成了但后台还在跑'？"
> "动手修改吧 修改完让另外两外review"

### Scope

Fix two A2A routing issues:

1. Revoke callback identities and dispatch contexts immediately when a run is cancelled, completed, or failed.
2. Emit callback-path snapshots only after dispatch state has been updated, using the same snapshot path as the rest of the orchestrator.

### Changed Areas

- `packages/api/src/orchestrator/invocation-registry.ts`
- `packages/api/src/orchestrator/invocation-registry.test.ts`
- `packages/api/src/routes/callbacks.ts`
- `packages/api/src/routes/callbacks.test.ts`
- `packages/api/src/server.ts`
- `packages/api/src/services/message-service.ts`
- `packages/api/src/services/message-service.test.ts`

### Risks To Review

1. Stop/cancel now revokes callback access immediately while keeping the thread lock until the run settles.
2. Completed and failed runs now release callback identity and dispatch context eagerly instead of waiting for TTL.
3. Callback snapshots now rely on the unified `MessageService.emitThreadSnapshot()` path wired from the server.

### Verification

- `pnpm --filter @multi-agent/api build`
- `pnpm typecheck`
- `pnpm exec biome check packages/api/src/orchestrator/invocation-registry.ts packages/api/src/orchestrator/invocation-registry.test.ts packages/api/src/routes/callbacks.ts packages/api/src/routes/callbacks.test.ts packages/api/src/server.ts packages/api/src/services/message-service.ts packages/api/src/services/message-service.test.ts`
- `node packages/api/dist/orchestrator/invocation-registry.test.js`
- `node packages/api/dist/routes/callbacks.test.js`
- `node packages/api/dist/services/message-service.test.js`

### Notes

- Full-repo `pnpm lint` is currently noisy because the workspace has pre-existing generated `.next` diagnostics and unrelated dirty files; this change set was checked with targeted Biome plus build/typecheck/tests above.
