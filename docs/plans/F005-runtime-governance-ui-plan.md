# F005 — Runtime Governance UI Implementation Plan

**Feature:** F005 — `docs/features/F005-runtime-governance-ui.md`
**Goal:** 将权限系统、右侧面板、左侧侧边栏从三个孤岛重构为统一的运行时治理 UI，实现三级 scope 权限 + glob 匹配 + SQLite 持久化 + 渐进式授权
**Acceptance Criteria:** AC1–AC21（详见 feature doc，plan 逐条覆盖）
**Architecture:** 后端 AuthorizationRuleStore（SQLite 持久化 + glob 匹配） → ApprovalManager 重构（规则命中自动放行） → 前端审批卡片三级 scope + 执行条 + 桌面通知 → 右侧 Tab 重构 + 设置 Modal → 左侧项目分组侧边栏
**Tech Stack:** Node.js `node:sqlite` DatabaseSync / Zustand / Next.js App Router / WebSocket / Desktop Notification API

---

## Terminal Schema（终态数据结构 — 所有 Task 围绕此构建）

### 1. Shared Types (`packages/shared/src/realtime.ts` 新增/修改)

```typescript
// ── 结构化审批指纹 ────���─────────────────────────────────
export type ApprovalFingerprint = {
  tool: string           // "run_command" | "edit_file" | "npm" | ...
  target?: string        // "rm -rf /tmp" | "config.json" | ...
  risk: "low" | "medium" | "high"
}

// ApprovalRequest — 增加 fingerprint 字段
export type ApprovalRequest = {
  requestId: string
  provider: Provider
  agentAlias: string
  threadId: string
  sessionGroupId: string
  action: string                    // 显示用标签（向后兼容）
  fingerprint: ApprovalFingerprint  // 新增：结构化身份
  reason: string
  context?: string
  createdAt: string
}

// ── 持久化授权规则 ──────────────────────────────────────
export type AuthorizationRule = {
  id: string
  provider: Provider | "*"
  action: string             // glob 模式："npm *"、"run_command"、"*"
  scope: "thread" | "global"
  decision: "allow" | "deny"
  threadId?: string          // scope=thread 时有值
  sessionGroupId?: string    // scope=thread 时有值
  createdAt: string
  createdBy: string
  reason?: string
}

// ── SessionGroupSummary 扩展 ──────────────────────────
export type SessionGroupSummary = {
  id: string
  title: string
  updatedAtLabel: string
  projectTag?: string        // 新增：项目标签
  previews: Array<{ provider: Provider; alias: string; text: string }>
}

// ── 新增 RealtimeServerEvent 类型 ─────────────────────
// approval.auto_granted — 规则自动放行时通知前端（可选，用于执行条计数）
| { type: "approval.auto_granted"; payload: { provider: Provider; action: string; ruleId: string } }
```

### 2. SQLite Schema（`packages/api/src/db/sqlite.ts` 新增表）

```sql
CREATE TABLE IF NOT EXISTS authorization_rules (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('thread', 'global')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  thread_id TEXT,
  session_group_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  reason TEXT
);

CREATE TABLE IF NOT EXISTS authorization_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  provider TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'pending')),
  scope TEXT,
  matched_rule_id TEXT,
  created_at TEXT NOT NULL
);

-- session_groups 增加 project_tag
ALTER TABLE session_groups ADD COLUMN project_tag TEXT;
```

### 3. API Contracts（新增 REST 路由）

```
GET    /api/approval/pending?sessionGroupId=     → { pending: PendingRequestRecord[] }
POST   /api/authorization/respond                → { requestId, granted, scope, reason? } → { status, record }
GET    /api/authorization/rules?provider=&threadId= → { rules: AuthorizationRule[] }
POST   /api/authorization/rules                  → { ...rule fields } → { status, rule }
DELETE /api/authorization/rules/:id              → { status: "ok" }
PATCH  /api/session-groups/:id                   → { projectTag?, title? } → { status: "ok" }
```

---

## Phase 1: 权限治理核心（后端 + 协议）

覆盖 AC: AC1, AC2, AC3, AC4, AC5, AC6

### Task 1: Shared Types — ApprovalFingerprint + AuthorizationRule

**Files:**
- Modify: `packages/shared/src/realtime.ts`
- Modify: `packages/shared/src/constants.ts`（如需 export）

**Step 1: Write the failing test**

```typescript
// packages/api/src/orchestrator/approval-manager.test.ts — 新增测试
it("ApprovalRequest should include fingerprint field", () => {
  // 验证类型编译通过 — fingerprint 是必填字段
  const req: ApprovalRequest = {
    requestId: "r1", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "run_command",
    fingerprint: { tool: "run_command", target: "npm test", risk: "low" },
    reason: "test", createdAt: new Date().toISOString(),
  }
  assert.equal(req.fingerprint.tool, "run_command")
})
```

**Step 2:** Run `pnpm --filter @multi-agent/shared lint` — Expected: FAIL (fingerprint 字段不存在)

**Step 3: Write types in realtime.ts**

在 `ApprovalRequest` 类型前新增 `ApprovalFingerprint` 类型定义。
修改 `ApprovalRequest` 增加 `fingerprint: ApprovalFingerprint` 字段。
新增 `AuthorizationRule` 类型 export。

**Step 4:** Run lint — Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(F005): add ApprovalFingerprint + AuthorizationRule shared types [黄仁勋/Opus-46 🐾]"
```

---

### Task 2: SQLite Migration — authorization_rules + authorization_audit 表

**Files:**
- Modify: `packages/api/src/db/sqlite.ts:80-190`（migrate 方法）

**Step 1: Write the failing test**

```typescript
// packages/api/src/db/authorization-rule-store.test.ts (新文件)
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SqliteStore } from "./sqlite"
import { AuthorizationRuleRepository } from "./repositories/authorization-rule-repository"

describe("AuthorizationRuleRepository", () => {
  let store: SqliteStore
  let repo: AuthorizationRuleRepository

  beforeEach(() => {
    store = new SqliteStore(":memory:")
    repo = new AuthorizationRuleRepository(store)
  })

  it("add and list rules", () => {
    const rule = repo.add({
      provider: "codex", action: "npm *", scope: "global",
      decision: "allow", createdBy: "user",
    })
    assert.ok(rule.id)
    assert.equal(rule.action, "npm *")

    const rules = repo.list()
    assert.equal(rules.length, 1)
  })
})
```

**Step 2:** Run test — Expected: FAIL (tables don't exist, repository doesn't exist)

**Step 3: Add migration + repository**

在 `SqliteStore.migrate()` 末尾新增 `authorization_rules` 和 `authorization_audit` 建表语句。
新建 `packages/api/src/db/repositories/authorization-rule-repository.ts`：

```typescript
import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import type { SqliteStore } from "../sqlite"

export type AuthorizationRuleRow = {
  id: string
  provider: string
  action: string
  scope: "thread" | "global"
  decision: "allow" | "deny"
  thread_id: string | null
  session_group_id: string | null
  created_at: string
  created_by: string
  reason: string | null
}

export class AuthorizationRuleRepository {
  constructor(private readonly store: SqliteStore) {}

  add(input: {
    provider: string
    action: string
    scope: "thread" | "global"
    decision: "allow" | "deny"
    threadId?: string
    sessionGroupId?: string
    createdBy: string
    reason?: string
  }): AuthorizationRuleRow {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.store.db.exec(`
      INSERT INTO authorization_rules (id, provider, action, scope, decision, thread_id, session_group_id, created_at, created_by, reason)
      VALUES ('${id}', '${input.provider}', '${input.action}', '${input.scope}', '${input.decision}', ${input.threadId ? `'${input.threadId}'` : 'NULL'}, ${input.sessionGroupId ? `'${input.sessionGroupId}'` : 'NULL'}, '${now}', '${input.createdBy}', ${input.reason ? `'${input.reason}'` : 'NULL'})
    `)
    // 注意：实际实现用 prepared statement，这里示意
    return { id, provider: input.provider, action: input.action, scope: input.scope, decision: input.decision, thread_id: input.threadId ?? null, session_group_id: input.sessionGroupId ?? null, created_at: now, created_by: input.createdBy, reason: input.reason ?? null }
  }

  remove(ruleId: string): boolean {
    const result = this.store.db.prepare("DELETE FROM authorization_rules WHERE id = ?").run(ruleId)
    return result.changes > 0
  }

  list(filter?: { provider?: string; threadId?: string }): AuthorizationRuleRow[] {
    // 带可选过滤的查询
  }

  listAll(): AuthorizationRuleRow[] {
    return this.store.db.prepare("SELECT * FROM authorization_rules ORDER BY created_at DESC").all() as AuthorizationRuleRow[]
  }
}
```

**Step 4:** Run test — Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(F005): SQLite migration + AuthorizationRuleRepository [黄仁勋/Opus-46 🐾]"
```

---

### Task 3: AuthorizationRuleStore — glob 匹配 + 规则优先级

**Files:**
- Create: `packages/api/src/orchestrator/authorization-rule-store.ts`
- Create: `packages/api/src/orchestrator/authorization-rule-store.test.ts`

这是权限系统的核心匹配引擎。参照 clowder-ai 的 `AuthorizationRuleStore`（`reference-code/clowder-ai/packages/api/src/domains/cats/services/stores/ports/AuthorizationRuleStore.ts:28-35`）。

**Step 1: Write failing tests**

```typescript
describe("AuthorizationRuleStore", () => {
  it("exact match: 'npm test' matches 'npm test'", () => {
    store.addRule({ provider: "codex", action: "npm test", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
  })

  it("glob match: 'npm *' matches 'npm test'", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
    assert.equal(store.match("codex", "npm install", "t1")?.decision, "allow")
  })

  it("wildcard '*' matches everything", () => {
    store.addRule({ provider: "*", action: "*", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "anything", "t1")?.decision, "allow")
  })

  it("thread-scoped rule takes precedence over global", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    store.addRule({ provider: "codex", action: "npm *", scope: "thread", decision: "deny", threadId: "t1" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "deny")
    assert.equal(store.match("codex", "npm test", "t2")?.decision, "allow")
  })

  it("no match returns null", () => {
    assert.equal(store.match("codex", "unknown", "t1"), null)
  })

  it("later rule wins within same scope", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "deny" })
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
  })
})
```

**Step 2:** Run — Expected: FAIL

**Step 3: Implement AuthorizationRuleStore**

```typescript
function matchAction(pattern: string, action: string): boolean {
  if (pattern === "*") return true
  if (pattern === action) return true
  if (pattern.endsWith("*")) return action.startsWith(pattern.slice(0, -1))
  return false
}

export class AuthorizationRuleStore {
  constructor(private readonly ruleRepo: AuthorizationRuleRepository) {}

  addRule(input: { provider: string; action: string; scope: "thread" | "global"; decision: "allow" | "deny"; threadId?: string; sessionGroupId?: string; reason?: string }): AuthorizationRuleRow {
    return this.ruleRepo.add({ ...input, createdBy: "user" })
  }

  removeRule(ruleId: string): boolean {
    return this.ruleRepo.remove(ruleId)
  }

  match(provider: string, action: string, threadId: string): AuthorizationRuleRow | null {
    const rules = this.ruleRepo.listAll()
    let bestThread: AuthorizationRuleRow | null = null
    let bestGlobal: AuthorizationRuleRow | null = null

    for (const rule of rules) {
      const providerMatch = rule.provider === "*" || rule.provider === provider
      if (!providerMatch) continue
      if (!matchAction(rule.action, action)) continue

      if (rule.scope === "thread" && rule.thread_id === threadId) {
        if (!bestThread || rule.created_at > bestThread.created_at) bestThread = rule
      } else if (rule.scope === "global") {
        if (!bestGlobal || rule.created_at > bestGlobal.created_at) bestGlobal = rule
      }
    }
    return bestThread ?? bestGlobal ?? null
  }

  listRules(filter?: { provider?: string; threadId?: string }): AuthorizationRuleRow[] {
    return this.ruleRepo.list(filter)
  }
}
```

**Step 4:** Run — Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(F005): AuthorizationRuleStore with glob matching [黄仁勋/Opus-46 🐾]"
```

---

### Task 4: ApprovalManager 重构 — 规则匹配 + scope 处理

**Files:**
- Modify: `packages/api/src/orchestrator/approval-manager.ts`
- Modify: `packages/api/src/orchestrator/approval-manager.test.ts`

关键变化：`requestPermission` 流程变为 **查规则 → 命中则自动放行 → 未命中则创建 pending → 等待审批**。`respond` 方法在 scope !== "once" 时**创建持久化规则**。

**Step 1: Write failing tests**

```typescript
it("auto-grants when a matching global rule exists", async () => {
  // 预先添加规则
  ruleStore.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
  const result = await manager.requestPermission({
    invocationId: "inv-1", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "npm test", fingerprint: { tool: "npm", target: "test", risk: "low" },
    reason: "运行测试",
  })
  assert.equal(result.status, "granted")
  // 不应该 emit approval.request（自动放行无需前端参与）
  assert.equal(emitted.filter(e => e.type === "approval.request").length, 0)
})

it("respond with scope=global creates a persistent rule", async () => {
  const promise = manager.requestPermission({
    invocationId: "inv-2", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "npm test", fingerprint: { tool: "npm", target: "test", risk: "low" },
    reason: "运行测试",
  })
  const reqId = (emitted[0].payload as { requestId: string }).requestId
  manager.respond(reqId, true, "global")
  await promise

  // 下次同样的请求应该自动放行
  const result2 = await manager.requestPermission({
    invocationId: "inv-3", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "npm test", fingerprint: { tool: "npm", target: "test", risk: "low" },
    reason: "运行测试",
  })
  assert.equal(result2.status, "granted")
})

it("respond with scope=thread creates a thread-scoped rule", async () => {
  const promise = manager.requestPermission({
    invocationId: "inv-4", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "edit_file", fingerprint: { tool: "edit_file", risk: "medium" },
    reason: "修改文件",
  })
  const reqId = (emitted[0].payload as { requestId: string }).requestId
  manager.respond(reqId, true, "thread")
  await promise

  // 同 thread 自动放行
  const r1 = await manager.requestPermission({
    invocationId: "inv-5", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "edit_file", fingerprint: { tool: "edit_file", risk: "medium" },
    reason: "修改文件",
  })
  assert.equal(r1.status, "granted")

  // 不同 thread 不放行（还是 pending）
  const p2 = manager.requestPermission({
    invocationId: "inv-6", provider: "codex", agentAlias: "范德彪",
    threadId: "t2", sessionGroupId: "g1",
    action: "edit_file", fingerprint: { tool: "edit_file", risk: "medium" },
    reason: "修改文件",
  })
  // 应该 emit 一个新的 approval.request
  const newReqs = emitted.filter(e => e.type === "approval.request")
  assert.equal(newReqs.length, 2) // 第一次 + 这次
  // 清理：respond 掉
  const reqId2 = (newReqs[1].payload as { requestId: string }).requestId
  manager.respond(reqId2, true, "once")
  await p2
})

it("getPending returns waiting requests for a sessionGroupId", async () => {
  manager.requestPermission({
    invocationId: "inv-7", provider: "codex", agentAlias: "范德彪",
    threadId: "t1", sessionGroupId: "g1",
    action: "run_command", fingerprint: { tool: "run_command", risk: "high" },
    reason: "test",
  })
  const pending = manager.getPending("g1")
  assert.equal(pending.length, 1)
  assert.equal(pending[0].action, "run_command")
})
```

**Step 2:** Run — Expected: FAIL

**Step 3: Refactor ApprovalManager**

```typescript
export class ApprovalManager {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly emit: (event: RealtimeServerEvent) => void,
    private readonly ruleStore: AuthorizationRuleStore,
    private readonly timeoutMs = 120_000,
  ) {}

  requestPermission(params: {
    invocationId: string
    provider: Provider
    agentAlias: string
    threadId: string
    sessionGroupId: string
    action: string
    fingerprint: ApprovalFingerprint
    reason: string
    context?: string
  }): Promise<ApprovalResult> {
    // Step 1: 查规则
    const rule = this.ruleStore.match(params.provider, params.action, params.threadId)
    if (rule) {
      const status = rule.decision === "allow" ? "granted" : "denied"
      if (rule.decision === "allow") {
        this.emit({ type: "approval.auto_granted", payload: { provider: params.provider, action: params.action, ruleId: rule.id } })
      }
      return Promise.resolve({ status } as ApprovalResult)
    }

    // Step 2: 创建 pending（和原来一样）
    // ...existing pending logic...
  }

  respond(requestId: string, granted: boolean, scope: ApprovalScope): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)

    // 如果 scope 不是 once，创建持久化规则
    if (scope !== "once") {
      this.ruleStore.addRule({
        provider: entry.request.provider,
        action: entry.request.action,
        scope,
        decision: granted ? "allow" : "deny",
        ...(scope === "thread" ? { threadId: entry.request.threadId, sessionGroupId: entry.request.sessionGroupId } : {}),
      })
    }

    this.emit({ type: "approval.resolved", payload: { requestId, granted } })
    entry.resolve({ status: granted ? "granted" : "denied" })
    return true
  }

  getPending(sessionGroupId: string): ApprovalRequest[] {
    const result: ApprovalRequest[] = []
    for (const entry of this.pending.values()) {
      if (entry.request.sessionGroupId === sessionGroupId) {
        result.push(entry.request)
      }
    }
    return result
  }

  // ...existing cancelAll, hasPending...
}
```

**Step 4:** Run — Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(F005): ApprovalManager rule matching + scope persistence [黄仁勋/Opus-46 🐾]"
```

---

### Task 5: Authorization REST Routes

**Files:**
- Create: `packages/api/src/routes/authorization.ts`
- Create: `packages/api/src/routes/authorization.test.ts`
- Modify: `packages/api/src/server.ts`（注册路由）

**Step 1: Write failing test**

```typescript
describe("authorization routes", () => {
  it("GET /api/approval/pending returns pending requests", async () => {
    // ... setup approval manager with a pending request
    const response = await app.inject({ method: "GET", url: "/api/approval/pending?sessionGroupId=g1" })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.payload)
    assert.ok(Array.isArray(body.pending))
  })

  it("GET /api/authorization/rules returns rules list", async () => {
    const response = await app.inject({ method: "GET", url: "/api/authorization/rules" })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.payload)
    assert.ok(Array.isArray(body.rules))
  })

  it("POST /api/authorization/rules creates a rule", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/authorization/rules",
      payload: { provider: "codex", action: "npm *", scope: "global", decision: "allow" }
    })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.payload)
    assert.equal(body.rule.action, "npm *")
  })

  it("DELETE /api/authorization/rules/:id removes a rule", async () => {
    // ... add rule, then delete
    const response = await app.inject({ method: "DELETE", url: `/api/authorization/rules/${ruleId}` })
    assert.equal(response.statusCode, 200)
  })
})
```

**Step 2:** Run — Expected: FAIL

**Step 3: Implement routes**

```typescript
export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: { approvals: ApprovalManager; ruleStore: AuthorizationRuleStore }
) {
  app.get("/api/approval/pending", async (request) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId) return { pending: [] }
    return { pending: options.approvals.getPending(sessionGroupId) }
  })

  app.get("/api/authorization/rules", async (request) => {
    const query = request.query as { provider?: string; threadId?: string }
    return { rules: options.ruleStore.listRules(query) }
  })

  app.post("/api/authorization/rules", async (request) => {
    const { provider, action, scope, decision, threadId, sessionGroupId, reason } = request.body as any
    const rule = options.ruleStore.addRule({ provider, action, scope, decision, threadId, sessionGroupId, reason })
    return { status: "ok", rule }
  })

  app.delete("/api/authorization/rules/:id", async (request) => {
    const { id } = request.params as { id: string }
    const removed = options.ruleStore.removeRule(id)
    if (!removed) { /* 404 */ }
    return { status: "ok" }
  })
}
```

**Step 4: Wire up in server.ts**

```typescript
// server.ts — 在 approvals 创建后
const ruleRepo = new AuthorizationRuleRepository(sqlite)
const ruleStore = new AuthorizationRuleStore(ruleRepo)
const approvals = new ApprovalManager((event) => broadcaster.broadcast(event), ruleStore)
// ...
registerAuthorizationRoutes(app, { approvals, ruleStore })
```

**Step 5:** Run — Expected: PASS

**Step 6: Commit**
```bash
git commit -m "feat(F005): authorization REST routes + server wiring [黄仁勋/Opus-46 🐾]"
```

---

### Task 6: WS Route — fingerprint 传递 + approval.respond scope 正确处理

**Files:**
- Modify: `packages/api/src/routes/ws.ts:74-80`
- Modify: `packages/api/src/routes/callbacks.ts`（requestPermission 调用处传 fingerprint）

**Step 1:** 确认 ws.ts 中 `approval.respond` 已经正确传 scope（当前代码 L74-80 已传 `event.payload.scope`）。

**Step 2:** 修改 `callbacks.ts` 中 `requestPermission` 的调用处，确保 fingerprint 字段被传入。

这需要追踪 `requestPermission` 在 callbacks.ts 中的使用方式，确保 CLI 端发来的权限请求包含结构化信息。如果 CLI 端暂时只发 `action` 字符串，后端需要做一个 **fingerprint 推断层**：

```typescript
function inferFingerprint(action: string, context?: string): ApprovalFingerprint {
  if (action.startsWith("npm ") || action.startsWith("pnpm ")) return { tool: "npm", target: action, risk: "low" }
  if (action.startsWith("rm ") || action.includes("delete")) return { tool: "run_command", target: action, risk: "high" }
  if (action.startsWith("edit_file") || action.startsWith("write_file")) return { tool: "edit_file", target: context, risk: "medium" }
  return { tool: action.split(" ")[0] || action, target: action, risk: "medium" }
}
```

**Step 3: Commit**
```bash
git commit -m "feat(F005): fingerprint inference + ws scope passthrough [黄仁勋/Opus-46 🐾]"
```

---

## Phase 2: 前端审批卡片 + 执行条 + 通知

覆盖 AC: AC7, AC8, AC9, AC10

### Task 7: ApprovalCard 三级 scope UI

**Files:**
- Modify: `components/chat/approval-card.tsx`

**Step 1: Write the target component**

参照 clowder-ai `AuthorizationCard.tsx`（`reference-code/clowder-ai/packages/web/src/components/AuthorizationCard.tsx:38-99`）。

默认态 3 按钮：
- ✅ 允许（仅此次）
- ⚙ 更多选项...
- ❌ 拒绝

展开态 6 按钮：
- ✅ 允许（仅此次）
- ✅ 允许（此会话）
- ✅ 允许（全局）
- ❌ 拒绝（仅此次）
- ❌ 拒绝（全局）
- 收起

```typescript
export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="... border-amber-200 ... animate-pulse-subtle">
      {/* 头部：provider avatar + action badge + reason */}
      {/* ... 保留现有头部结构 ... */}

      <div className="mt-3 flex items-center gap-2 ml-7">
        {!expanded ? (
          <>
            <button onClick={() => onRespond(request.requestId, true, "once")}
              className="px-3 py-1.5 text-xs bg-emerald-500 text-white rounded-lg ...">
              允许 (仅此次)
            </button>
            <button onClick={() => setExpanded(true)}
              className="px-3 py-1.5 text-xs bg-slate-200 text-slate-600 rounded-lg ...">
              更多选项...
            </button>
            <button onClick={() => onRespond(request.requestId, false, "once")}
              className="px-3 py-1.5 text-xs bg-white text-red-600 border border-red-200 rounded-lg ...">
              拒绝
            </button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => onRespond(request.requestId, true, "once")} ...>允许 (仅此次)</button>
            <button onClick={() => onRespond(request.requestId, true, "thread")} ...>允许 (此会话)</button>
            <button onClick={() => onRespond(request.requestId, true, "global")} ...>允许 (全局)</button>
            <button onClick={() => onRespond(request.requestId, false, "once")} ...>拒绝 (仅此次)</button>
            <button onClick={() => onRespond(request.requestId, false, "global")} ...>拒绝 (全局)</button>
            <button onClick={() => setExpanded(false)} ...>收起</button>
          </div>
        )}
      </div>

      {/* 审批卡片边缘低频黄色呼吸脉冲 — AC10 */}
      {/* 用 CSS animation: border-color pulse on amber */}
    </div>
  )
}
```

**Step 2:** 启动 dev server，验证卡片展开/收起，scope 正确传递

**Step 3: Commit**
```bash
git commit -m "feat(F005): ApprovalCard progressive scope UI [黄仁勋/Opus-46 🐾]"
```

---

### Task 8: ExecutionBar 执行条组件

**Files:**
- Create: `components/chat/execution-bar.tsx`
- Modify: `app/page.tsx`（在 Composer 上方插入）
- Modify: `components/stores/thread-store.ts`（或新建 execution-store.ts）

**Step 1: Design the component**

执行条常驻在 Composer 上方，显示：
- 各 agent 运行状态（provider 图标 + 状态点：running/idle/waiting）
- Pending 审批计数（如有，显示黄色 badge）

```typescript
export function ExecutionBar() {
  const providers = useThreadStore((s) => s.providers)
  const pendingCount = useApprovalStore((s) => s.pending.length)

  const entries = PROVIDERS.map((p) => ({
    provider: p,
    alias: PROVIDER_ALIASES[p],
    running: providers[p].running,
  }))

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-200/60 bg-slate-50/50">
      {entries.map(({ provider, alias, running }) => (
        <div key={provider} className="flex items-center gap-1.5 text-xs text-slate-500">
          <ProviderAvatar identity={provider} size="xs" />
          <span className={`h-2 w-2 rounded-full ${running ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
          <span>{alias}</span>
        </div>
      ))}
      {pendingCount > 0 && (
        <div className="ml-auto flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5" />
          {pendingCount} 待审批
        </div>
      )}
    </div>
  )
}
```

**Step 2: Insert into page layout**

在 `app/page.tsx` 的 `<Composer />` 上方加入 `<ExecutionBar />`。

**Step 3:** 启动 dev server 验证

**Step 4: Commit**
```bash
git commit -m "feat(F005): ExecutionBar — agent status + pending count [黄仁勋/Opus-46 🐾]"
```

---

### Task 9: useApprovalNotification hook

**Files:**
- Create: `components/hooks/use-approval-notification.ts`
- Modify: `app/page.tsx`（调用 hook）

**Step 1: Implement hook**

```typescript
import { useEffect, useRef } from "react"
import { useApprovalStore } from "../stores/approval-store"

export function useApprovalNotification() {
  const pending = useApprovalStore((s) => s.pending)
  const notifiedRef = useRef(new Set<string>())
  const originalTitle = useRef(document.title)

  useEffect(() => {
    for (const req of pending) {
      if (notifiedRef.current.has(req.requestId)) continue
      notifiedRef.current.add(req.requestId)

      // Desktop Notification
      if (Notification.permission === "granted") {
        new Notification(`${req.agentAlias} 需要权限`, {
          body: `${req.action}: ${req.reason}`,
          tag: `approval-${req.requestId}`,
          requireInteraction: true,
        })
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission()
      }
    }

    // Tab title 闪烁
    if (pending.length > 0 && document.hidden) {
      document.title = `(${pending.length}) 待审批 — ${originalTitle.current}`
    } else {
      document.title = originalTitle.current
    }

    // 清理已不在 pending 中的 notified ids
    const currentIds = new Set(pending.map((r) => r.requestId))
    for (const id of notifiedRef.current) {
      if (!currentIds.has(id)) notifiedRef.current.delete(id)
    }
  }, [pending])

  // 页面可见性变化恢复标题
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) {
        document.title = originalTitle.current
      }
    }
    document.addEventListener("visibilitychange", handler)
    return () => document.removeEventListener("visibilitychange", handler)
  }, [])
}
```

**Step 2: Call in page.tsx**

```typescript
// app/page.tsx
import { useApprovalNotification } from "@/components/hooks/use-approval-notification"
// Inside HomePage:
useApprovalNotification()
```

**Step 3:** 验证（创建测试审批 → 切到别的 tab → 确认 notification 弹出 + title 闪烁）

**Step 4: Commit**
```bash
git commit -m "feat(F005): useApprovalNotification — desktop + tab title [黄仁勋/Opus-46 🐾]"
```

---

### Task 10: Approval pending 恢复（刷新后）

**Files:**
- Modify: `components/stores/approval-store.ts`
- Modify: `components/stores/thread-store.ts`（bootstrap 时 fetch pending）

**Step 1: Add fetchPending to approval store**

```typescript
export const useApprovalStore = create<ApprovalStore>((set) => ({
  pending: [],
  // ...existing...
  fetchPending: async (sessionGroupId: string) => {
    const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
    const res = await fetch(`${baseUrl}/api/approval/pending?sessionGroupId=${sessionGroupId}`)
    if (!res.ok) return
    const { pending } = await res.json() as { pending: ApprovalRequest[] }
    set({ pending })
  },
}))
```

**Step 2: Call in thread-store bootstrap / selectSessionGroup**

在 `selectSessionGroup` 成功后调用 `useApprovalStore.getState().fetchPending(groupId)`。

**Step 3: Commit**
```bash
git commit -m "feat(F005): approval pending recovery on page refresh [黄仁勋/Opus-46 🐾]"
```

---

## Phase 3: 右侧面板 Tab 重构 + 独立设置 Modal

覆盖 AC: AC11, AC12, AC13

### Task 11: StatusPanel Tab 结构

**Files:**
- Modify: `components/chat/status-panel.tsx`（大改）

**Step 1: Restructure into Tabs**

将 StatusPanel 从单一滚动列表改为三个 Tab：
- **会话态**（当前模型 / effort / 运行状态 / 会话链）
- **全局态**（默认配置 — 从当前"折叠区"提取）
- **审批规则**（当前会话 pending + 最近匹配规则列表）

```typescript
type TabId = "session" | "defaults" | "rules"

export function StatusPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("session")

  return (
    <aside className="flex h-screen w-[340px] flex-col ... ">
      {/* Tab 头 */}
      <div className="flex border-b border-slate-200/60 mb-4">
        {(["session", "defaults", "rules"] as TabId[]).map((tab) => (
          <button key={tab}
            className={`flex-1 py-2 text-xs font-semibold ${activeTab === tab ? "border-b-2 border-amber-500 text-amber-600" : "text-slate-400"}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "session" ? "会话" : tab === "defaults" ? "默认" : "审批规则"}
          </button>
        ))}
      </div>

      {activeTab === "session" && <SessionTab />}
      {activeTab === "defaults" && <DefaultsTab />}
      {activeTab === "rules" && <RulesTab />}
    </aside>
  )
}
```

**SessionTab**: 房间健康度 + 消息统计 + 智能体配置（只有"当前会话"模型选择器，没有默认配置折叠区）+ 会话链
**DefaultsTab**: 每个 provider 的默认模型/effort 配置
**RulesTab**: pending 审批列表 + 最近生效的规则列表（从 `/api/authorization/rules` fetch）

**Step 2: AC13 — 消除模型配置双入口**

在 SessionTab 中，provider 卡片的模型 input **只控制当前会话**。删除原来的"默认配置"折叠区。
在 DefaultsTab 中，provider 卡片的模型 input **只控制全局默认**。
两个 Tab 用不同的背景色 / 标签做视觉硬切。

**Step 3:** 启动 dev server 验证 Tab 切换、视觉分区清晰

**Step 4: Commit**
```bash
git commit -m "feat(F005): StatusPanel 3-tab restructure [黄仁勋/Opus-46 🐾]"
```

---

### Task 12: 独立设置 Modal

**Files:**
- Create: `components/chat/settings-modal.tsx`
- Create: `components/stores/settings-modal-store.ts`
- Modify: `app/page.tsx`（挂载 Modal）
- Modify: `components/chat/status-panel.tsx`（添加"设置"入口按钮）

**Step 1: Implement Modal shell**

```typescript
export function SettingsModal() {
  const open = useSettingsModalStore((s) => s.open)
  const close = useSettingsModalStore((s) => s.close)
  const [activeTab, setActiveTab] = useState<"rules" | "general">("rules")

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[600px] max-h-[80vh] bg-white rounded-2xl shadow-xl overflow-hidden">
        {/* Tab 头 */}
        <div className="flex border-b px-6 pt-4">
          <button ...>权限规则</button>
          <button ...>通用</button>
          {/* 预留扩展 tab */}
        </div>

        {/* Tab 内容 */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-120px)]">
          {activeTab === "rules" && <RulesManagementPanel />}
          {activeTab === "general" && <div className="text-sm text-slate-400">更多设置即将推出</div>}
        </div>

        {/* 底部 */}
        <div className="flex justify-end px-6 py-4 border-t">
          <button onClick={close} ...>关闭</button>
        </div>
      </div>
    </div>
  )
}
```

**RulesManagementPanel**: 列出所有规则 + 删除按钮 + "一键重置所有权限"按钮。

**Step 2:** 在 StatusPanel 顶部或底部加一个"设置"齿轮图标按钮

**Step 3:** 启动 dev server 验证

**Step 4: Commit**
```bash
git commit -m "feat(F005): Settings Modal + rules management [黄仁勋/Opus-46 🐾]"
```

---

## Phase 4: 左侧侧边栏重做

覆盖 AC: AC14, AC15, AC16, AC17, AC18, AC19

### Task 13: 后端 project_tag 支持

**Files:**
- Modify: `packages/api/src/db/sqlite.ts`（migration 加 project_tag 列）
- Modify: `packages/api/src/db/repositories/session-repository.ts`（CRUD 支持 projectTag）
- Modify: `packages/api/src/routes/threads.ts`（PATCH session-group 支持 projectTag）
- Modify: `packages/shared/src/realtime.ts`（SessionGroupSummary 加 projectTag）

**Step 1: Write failing test**

```typescript
it("session group supports projectTag", () => {
  const groupId = repo.createSessionGroup()
  repo.updateSessionGroup(groupId, { projectTag: "multi-agent" })
  const group = repo.getSessionGroup(groupId)
  assert.equal(group.projectTag, "multi-agent")
})
```

**Step 2:** Migration + repository + route

**Step 3: Commit**
```bash
git commit -m "feat(F005): backend project_tag support [黄仁勋/Opus-46 🐾]"
```

---

### Task 14: SessionSidebar 项目分组 + Linear 视觉

**Files:**
- Modify: `components/chat/session-sidebar.tsx`（大改）
- Modify: `components/stores/thread-store.ts`（SessionListItem 扩展）

**Step 1: 数据模型扩展**

```typescript
type SessionListItem = {
  id: string
  title: string
  updatedAtLabel: string
  projectTag?: string     // 新增
  pinned?: boolean        // 新增（前端 localStorage 管理）
  unreadCount?: number    // 新增
  previews: Array<{ provider: Provider; alias: string; text: string }>
}
```

**Step 2: 分组逻辑**

```typescript
function groupByProject(items: SessionListItem[]): Map<string, SessionListItem[]> {
  const groups = new Map<string, SessionListItem[]>()
  for (const item of items) {
    const key = item.projectTag || "未分组"
    const list = groups.get(key) || []
    list.push(item)
    groups.set(key, list)
  }
  return groups
}
```

**Step 3: 视觉重做 — Linear 极简风格**

```typescript
<aside className="flex h-screen w-[288px] shrink-0 flex-col border-r border-slate-800/20 bg-slate-950 px-3 py-4">
  {/* 搜索框 — 深色背景适配 */}
  {/* 项目分组 — 折叠/展开 */}
  {groupedEntries.map(([project, items]) => (
    <div key={project}>
      <button className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        <ChevronDown className="h-3 w-3" />
        {project}
        <span className="ml-auto font-mono text-slate-600">{items.length}</span>
      </button>
      {items.map((item) => (
        <button key={item.id}
          className={`w-full px-3 py-2.5 text-left rounded-lg transition ${
            activeGroupId === item.id
              ? "bg-slate-800/80 border-l-2 border-amber-500"
              : "hover:bg-slate-900/50"
          }`}>
          <h3 className="text-sm font-medium text-slate-200 truncate">{item.title}</h3>
          <p className="text-xs text-slate-500 truncate mt-0.5">{item.previews[0]?.text || "尚无消息"}</p>
          <span className="text-[10px] text-slate-600">{item.updatedAtLabel}</span>
          {/* 未读 badge */}
          {(item.unreadCount ?? 0) > 0 && (
            <span className="ml-auto rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{item.unreadCount}</span>
          )}
        </button>
      ))}
    </div>
  ))}
</aside>
```

**Step 4: Commit**
```bash
git commit -m "feat(F005): SessionSidebar project grouping + Linear style [黄仁勋/Opus-46 🐾]"
```

---

### Task 15: 右键上下文菜单

**Files:**
- Create: `components/chat/session-context-menu.tsx`
- Modify: `components/chat/session-sidebar.tsx`（集成）

**Step 1: Implement context menu**

```typescript
export function SessionContextMenu({ x, y, groupId, onClose, onAction }: Props) {
  return (
    <div className="fixed z-50 w-48 rounded-lg bg-slate-900 border border-slate-700 shadow-xl py-1"
      style={{ left: x, top: y }}>
      <MenuItem icon={<Pin />} label="置顶" onClick={() => onAction("pin")} />
      <MenuItem icon={<Pencil />} label="重命名" onClick={() => onAction("rename")} />
      <MenuItem icon={<Archive />} label="归档" onClick={() => onAction("archive")} />
      <Separator />
      <MenuItem icon={<Trash2 />} label="删除" onClick={() => onAction("delete")} danger />
    </div>
  )
}
```

**Step 2:** 在 sidebar 的 item button 上加 `onContextMenu` handler

**Step 3: Commit**
```bash
git commit -m "feat(F005): session context menu [黄仁勋/Opus-46 🐾]"
```

---

### Task 16: 未读标记 + 运行态信号

**Files:**
- Modify: `components/stores/thread-store.ts`
- Modify: `app/page.tsx`（message.created 时检查是否非活跃 group）
- Modify: `components/chat/session-sidebar.tsx`

**Step 1: Unread tracking**

在 `page.tsx` 的 `onMessage` 中，当收到 `message.created` 事件且 message 的 sessionGroupId !== activeGroupId 时，更新 threadStore 中对应 group 的 unreadCount++。

**Step 2: Running status in sidebar**

在 sidebar 的 session item 中，根据 `providers[p].running` 判断是否有 agent 在运行，显示一个小绿色动画点。对于 waiting approval 状态，显示黄色点。

**Step 3: Commit**
```bash
git commit -m "feat(F005): unread badges + running status in sidebar [黄仁勋/Opus-46 🐾]"
```

---

## 贯穿项

### Task 17: WS 断连消息缓冲（AC20）

**Files:**
- Modify: `components/ws/client.ts`

**Step 1: 检查现状**

当前 `ws/client.ts` 已有指数退避重连（L16 BACKOFF_SCHEDULE）。缺少的是**断连期间发送的消息缓冲**。

**Step 2: Add message queue**

```typescript
class SocketClient {
  private messageQueue: RealtimeClientEvent[] = []

  send(event: RealtimeClientEvent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event))
    } else {
      this.messageQueue.push(event)
    }
  }

  private drainQueue() {
    while (this.messageQueue.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const event = this.messageQueue.shift()!
      this.socket.send(JSON.stringify(event))
    }
  }

  // In openSocket, after "open" event:
  // this.drainQueue()
}
```

**Step 3: Commit**
```bash
git commit -m "feat(F005): WS message queue during disconnect [黄仁勋/Opus-46 🐾]"
```

---

### Task 18: 三栏布局面板折叠/展开（AC21）

**Files:**
- Modify: `app/page.tsx`
- Create: `components/stores/layout-store.ts`

**Step 1: Layout store**

```typescript
type LayoutStore = {
  sidebarCollapsed: boolean
  statusPanelCollapsed: boolean
  toggleSidebar: () => void
  toggleStatusPanel: () => void
}
// 初始值从 localStorage 读取
```

**Step 2: Conditional render in page.tsx**

```typescript
{!sidebarCollapsed && <SessionSidebar />}
{sidebarCollapsed && <CollapsedSidebarToggle />}
// ... main ...
{!statusPanelCollapsed && <StatusPanel />}
{statusPanelCollapsed && <CollapsedStatusToggle />}
```

**Step 3: Commit**
```bash
git commit -m "feat(F005): collapsible sidebar + status panel [黄仁勋/Opus-46 🐾]"
```

---

## AC 覆盖映射

| AC | Task | 验证方式 |
|----|------|---------|
| AC1 — 结构化指纹 | Task 1, 6 | 类型编译 + 单元测试 |
| AC2 — 三级 scope | Task 4 | ApprovalManager 单元测试 |
| AC3 — SQLite 持久化 | Task 2, 3 | 单元测试 + DB 查询 |
| AC4 — glob 通配符 | Task 3 | AuthorizationRuleStore 单元测试 |
| AC5 — pending 接口 | Task 5, 10 | REST 测试 + 前端刷新验证 |
| AC6 — 自动放行 | Task 4 | 单元测试（auto-grants 场景） |
| AC7 — 渐进式 scope UI | Task 7 | 浏览器手动测试 |
| AC8 — 执行条 | Task 8 | 浏览器手动测试 |
| AC9 — 桌面通知 | Task 9 | 浏览器手动测试 |
| AC10 — 呼吸脉冲 | Task 7 | CSS animation 视觉验证 |
| AC11 — 右侧 3 Tab | Task 11 | 浏览器手动测试 |
| AC12 — 设置 Modal | Task 12 | 浏览器手动测试 |
| AC13 — 模型配置去冗余 | Task 11 | 浏览器验证两个 Tab 语义分离 |
| AC14 — 项目分组 | Task 14 | 浏览器手动测试 |
| AC15 — 右键菜单 | Task 15 | 浏览器手动测试 |
| AC16 — 未读标记 | Task 16 | 浏览器手动测试 |
| AC17 — 运行态信号 | Task 16 | 浏览器手动测试 |
| AC18 — Linear 视觉 | Task 14 | 视觉验收 |
| AC19 — project 数据模型 | Task 13 | 单元测试 |
| AC20 — WS 消息缓冲 | Task 17 | 手动断网测试 |
| AC21 — 面板折叠 | Task 18 | 浏览器手动测试 |

---

## 执行顺序与依赖

```
Task 1 (shared types) ────┐
                          ├→ Task 4 (ApprovalManager refactor) → Task 5 (REST routes) → Task 6 (WS wiring)
Task 2 (SQLite migration) ┤
Task 3 (RuleStore)────────┘

Task 7 (ApprovalCard) ─────→ Task 8 (ExecutionBar) → Task 9 (Notification) → Task 10 (pending recovery)

Task 11 (StatusPanel Tabs) → Task 12 (Settings Modal)

Task 13 (backend project_tag) → Task 14 (Sidebar) → Task 15 (Context menu) → Task 16 (Unread + running)

Task 17 (WS buffer) — 独立，任何时候可做
Task 18 (Layout collapse) — 独立，任何时候可做
```

Phase 1 (Task 1–6) **必须先完成**，Phase 2/3/4 可并行。

## 不做什么

- 不做工具调用 diff 可视化（P2，scope 太大，单独 feature）
- 不做审批事件 Web Push（只做桌面 Notification）
- ���做全量审计日志 UI（只在设置 Modal 展示规则列表）
- 不做 sidebar 拖拽排序（先支持置顶/分组，拖拽是 P3 优化）
- 不做 resizable split pane（先做折叠/展开，拖拽调宽是 P3）
