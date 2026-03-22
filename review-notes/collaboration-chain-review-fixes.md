## Review Request

Review-Target-ID: collaboration-chain-review-fixes
Branch: dev

### Original Requirements

Source: shared room review thread on 2026-03-21

> "runThreadTurn 没做组级（Group-level）排他。"
> "dispatch.blocked 在后端发了，但 app/page.tsx 没接。"
> "messages 表缺少 thinking 字段。"

### Scope

Address 桂芬's P1/P2 review feedback for collaboration-chain convergence:

1. Reject new user-root turns when another thread in the same session group is already running.
2. Surface `dispatch.blocked` feedback in the frontend instead of silently swallowing it.
3. Persist assistant thinking to SQLite and restore it through snapshots after reload.

### Changed Areas

- `packages/api/src/services/message-service.ts`
- `packages/api/src/services/message-service.test.ts`
- `packages/api/src/services/session-service.ts`
- `packages/api/src/db/sqlite.ts`
- `packages/api/src/db/repositories/session-repository.ts`
- `packages/api/src/db/repositories/session-repository.test.ts`
- `app/page.tsx`
- `components/stores/thread-store.ts`
- `components/chat/message-bubble.tsx`

### Risks To Review

1. Group-level exclusivity now blocks a new user root while another provider in the room is running, instead of auto-cancelling the current chain.
2. Thinking persistence now writes an additional `messages.thinking` column and relies on snapshot merge choosing the longer local/server copy.
3. Blocked follow-up mentions currently show up as status text, not as a dedicated toast or timeline event.

### Verification

- `pnpm exec tsc --noEmit`
- `pnpm --filter @multi-agent/shared typecheck`
- `pnpm --filter @multi-agent/api typecheck`
- `pnpm --filter @multi-agent/api build`
- `pnpm exec biome check app/page.tsx components/chat/message-bubble.tsx components/stores/thread-store.ts packages/api/src/db/sqlite.ts packages/api/src/db/repositories/session-repository.ts packages/api/src/db/repositories/session-repository.test.ts packages/api/src/services/session-service.ts packages/api/src/services/message-service.ts packages/api/src/services/message-service.test.ts`
- `node packages/api/dist/services/message-service.test.js`
- `node packages/api/dist/db/repositories/session-repository.test.js`
- `node packages/api/dist/routes/callbacks.test.js`
- `node packages/api/dist/orchestrator/dispatch.test.js`
- `node packages/api/dist/orchestrator/invocation-registry.test.js`

### Notes

- This round did not include a browser UI smoke run; frontend validation is limited to typecheck plus store/event-path verification.
