# F033 Interactive Cards Implementation Plan

**Feature:** F033 — `docs/features/F033-interactive-cards.md`
**Goal:** 让"选方案/确认操作"变成持久化的可点击块，选完留痕——`request_decision` 轨的渲染 + 生命周期 + 持久化升级。
**Acceptance Criteria:**
- AC1: select / multi_select / confirm 三 kind 经 MCP `request_decision` 可达，前端按 kind 分渲染（select=单选+显式提交，multi_select=复选+提交，confirm=上下文正文+确认/取消），选择经 WS `decision.respond` 结构化回传 resolve MCP promise
- AC2: 响应后卡片转 disabled 态（高亮所选、不可再点），选择结果持久化到 `decision_records`，浏览器刷新与服务器重启后 resolved 卡片仍按 anchor 渲染；重启时残留 pending 行标 orphaned（前端显示"已过期"）
- AC3: 回传到源 thread 的审计消息自带上下文（title + description + 所选 label），timeout 分支同样写留痕并标注"超时自动处理"
- AC4: 决策卡内任何 Enter 提交路径带 isComposing 守卫 + 组件测试；同族缺陷顺手修：composer.tsx 主输入框补守卫

**Architecture:** 全程走既有 `request_decision` 双向轨（MCP → callbacks → MessageService.requestDecision → DecisionManager blocking promise → WS → decision-store → DecisionCard → WS decision.respond）。新增 `decision_records` 表持久化生命周期（pending→resolved/timeout/orphaned），前端新增 records 轨渲染已决卡片。cc_rich / fan_in_selector / Decision Board(F002) 全部不动。
**Tech Stack:** drizzle (INIT_SQL 建表) + node:test (`pnpm test:api` = tsx --test) + vitest/@testing-library (`pnpm test:components`) + zustand。

---

## Straight-Line Check

**B（终点）**：agent 在房间里调 `request_decision(kind:"confirm", title:"要删掉这 3 个 worktree 吗", description:"...")`，小孙看到确认卡 → 点"确认" → agent promise 收到结构化结果 → 卡片变灰高亮所选留在时间线 → 刷新/重启还在 → 源 thread 有带上下文的审计消息。

**不做什么**：cc_rich 新 kind（Design Gate 已否）、F020 挂载矩阵、fan_in_selector 改动、Decision Board 改动、groupId 表单（YAGNI）、pending 决策跨重启恢复（重启即 orphan，fail-closed）。

**既有断线顺手修**（同管道，AC1 内）：`anchorMessageId` MCP 有广告、callbacks.ts:656 有传、server.ts:709 接线丢弃——修通。

## Terminal Schema

```ts
// packages/shared/src/realtime.ts（新增）
export type DecisionRecordStatus = "pending" | "resolved" | "timeout" | "orphaned"
export type DecisionRecord = {
  requestId: string
  sessionGroupId: string
  kind: DecisionRequest["kind"]
  title: string
  description?: string
  options: DecisionOption[]
  multiSelect?: boolean
  anchorMessageId?: string
  sourceProvider?: Provider
  sourceAlias?: string
  status: DecisionRecordStatus
  verdicts?: DecisionVerdict[]
  userInput?: string
  createdAt: string
  resolvedAt?: string
}
```

```sql
-- drizzle-instance.ts INIT_SQL（新增，自幂等）
CREATE TABLE IF NOT EXISTS decision_records (
  request_id TEXT PRIMARY KEY,
  session_group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,          -- JSON: title/description/options/multiSelect/anchorMessageId/sourceProvider/sourceAlias
  status TEXT NOT NULL DEFAULT 'pending',
  verdicts TEXT,                  -- JSON DecisionVerdict[]
  user_input TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_records_group ON decision_records(session_group_id, created_at);
```

API 面：`GET /api/decisions/records?sessionGroupId=` → `{ records: DecisionRecord[] }`（非 pending）。MCP `request_decision` 新增可选 `kind: "select"|"multi_select"|"confirm"`（不传 = 旧行为）。

kind 映射（callbacks 层唯一真相）：select→`multi_choice`+multiSelect=false；multi_select→`multi_choice`+multiSelect=true；confirm→`inline_confirmation`+默认 options `[{id:"confirm",label:"确认"},{id:"cancel",label:"取消"}]`（confirm 可不带 options，其余仍 ≥2）。

timeout 语义：`inline_confirmation` 超时 → 全 rejected（fail-closed）；`multi_choice`/`fan_in_selector` 超时 → 保持现状全 approved（零回归），留痕标注"超时自动处理"。

---

### Task 1: shared 类型

**Files:**
- Modify: `packages/shared/src/realtime.ts`（`DecisionVerdict` 定义后，~line 274）

Step 1: 加 `DecisionRecordStatus` + `DecisionRecord`（如上 Terminal Schema）。
Step 2: `pnpm typecheck` → PASS。
Step 3: Commit `feat(F033): shared DecisionRecord 类型 [黄仁勋]`。

### Task 2: decision_records 表 + repository（TDD）

**Files:**
- Create: `packages/api/src/db/repositories/decision-record-repository.ts`
- Create: `packages/api/src/db/repositories/decision-record-repository.test.ts`
- Modify: `packages/api/src/db/schema.ts`（roomDecisions 后 ~line 333 加 `decisionRecords` sqliteTable）
- Modify: `packages/api/src/db/drizzle-instance.ts`（INIT_SQL 加 CREATE TABLE + INDEX）

Step 1: 失败测试（node:test；**用 createDrizzleDb 真建库**，临时文件，遵守 test-schema-faithful；测试 spawn 无 git 操作，无需 cleanGitEnv）：
```ts
import assert from "node:assert/strict"
import test from "node:test"
// createDrizzleDb(tmpfile) → new DecisionRecordRepository(db)
test("insertPending → listBySessionGroup 返回 pending 行", ...)
test("markResolved 落 verdicts/userInput/status/resolvedAt", ...)
test("markResolved 幂等：已 resolved 不覆盖", ...)   // respond 与 timeout 竞态
test("orphanAllPending 只动 pending 行", ...)
test("listBySessionGroup({excludePending:true}) 不含 pending", ...)
```
Repository 接口：
```ts
export class DecisionRecordRepository {
  insertPending(record: Omit<DecisionRecord, "status" | "verdicts" | "userInput" | "resolvedAt">): void
  markResolved(requestId: string, status: "resolved" | "timeout", verdicts: DecisionVerdict[], userInput: string): boolean  // false = 已非 pending（幂等门）
  orphanAllPending(): number
  listBySessionGroup(sessionGroupId: string, opts?: { excludePending?: boolean; limit?: number }): DecisionRecord[]
}
```
Step 2: `pnpm test:api -- --test-name-pattern decision-record` → FAIL（module not found）。
Step 3: 实现（payload JSON 序列化/反序列化；markResolved 用 `WHERE status='pending'` 条件 UPDATE 拿 changes 数做幂等门）。
Step 4: 测试 PASS。
Step 5: Commit `feat(F033): decision_records 表 + repository [黄仁勋]`。

### Task 3: DecisionManager 持久化 + timeout 语义 + 留痕上下文（TDD）

**Files:**
- Modify: `packages/api/src/orchestrator/decision-manager.ts`
- Modify: `packages/api/src/orchestrator/decision-manager.test.ts`

Step 1: 失败测试（fake records facade 收集调用；timeout 用 `timeoutMs: 5` 真 timer）：
```ts
test("request() 落 pending 行", ...)
test("respond() markResolved(resolved) + verdicts 原样", ...)
test("timeout: inline_confirmation → 全 rejected（fail-closed）", ...)
test("timeout: multi_choice → 全 approved（现状回归保护）", ...)
test("timeout 也写审计消息且含『超时自动处理』", ...)
test("审计消息含 title + description + 所选 label", ...)
test("respond races timeout：只 resolve 一次、只落一次", ...)  // markResolved 幂等门 + pending Map delete 已互斥
```
Step 2: 确认 FAIL。
Step 3: 实现：
- 构造器加可选 `records?: { insertPending; markResolved }` 窄 facade（保持既有测试不传也能跑）。
- `request()`：`this.records?.insertPending({...request})`。
- timeout 分支：verdict 按 kind（`inline_confirmation` → rejected）；`markResolved(requestId, "timeout", fallback, "")`；调 `writeDecisionToThread(request, fallback, "", { timedOut: true })`。
- `respond()`：`markResolved(requestId, "resolved", decisions, userInput ?? "")`。
- `writeDecisionToThread` 头部改：`【决策卡】${title}`、description 一行、verdict 行不变、timedOut 时加"（超时自动处理，无人响应）"。
Step 4: PASS（全量 `pnpm test:api` 确认 F002 回归测试仍绿）。
Step 5: Commit `feat(F033): DecisionManager 持久化 + confirm 超时 fail-closed + 留痕带上下文 [黄仁勋]`。

### Task 4: 纵向管道打通 — kind + anchorMessageId（TDD）

**Files:**
- Create: `packages/api/src/routes/decision-callback-mapping.ts`（纯函数，kind 映射唯一真相）
- Create: `packages/api/src/routes/decision-callback-mapping.test.ts`
- Modify: `packages/api/src/routes/callbacks.ts:616-663`（request-decision handler 用映射 + confirm 放宽 options 校验）
- Modify: `packages/api/src/server.ts:709-721`（转发 kind/anchorMessageId，不再写死 multi_choice）
- Modify: `packages/api/src/services/message-service.ts:3220-3234`（params.kind 加 `"inline_confirmation"`，加 `anchorMessageId?`）
- Modify: `packages/api/src/mcp/server.ts:451-482`（inputSchema 加 kind enum + options 描述改"confirm 可省略"）+ `callRequestDecision`（688-714：kind 转发；confirm 跳过 ≥2 校验；confirm 结果文本"已确认/已取消"）

Step 1: 失败测试（映射纯函数）：
```ts
resolveDecisionParams({kind:"select", options:[a,b]})       // → multi_choice, multiSelect:false
resolveDecisionParams({kind:"multi_select", options:[a,b]}) // → multi_choice, multiSelect:true
resolveDecisionParams({kind:"confirm"})                     // → inline_confirmation + 默认确认/取消
resolveDecisionParams({kind:"confirm", options:[a,b]})      // → 自带 options 优先
resolveDecisionParams({options:[a,b], multiSelect:true})    // → legacy 不变
resolveDecisionParams({kind:"select", options:[a]})         // → error（<2）
resolveDecisionParams({kind:"bogus", ...})                  // → error（fail-closed，不静默当 select）
```
Step 2: FAIL → Step 3: 实现映射 + 五处接线（callbacks 校验改为 `!body.title?.trim() || mapping error`）→ Step 4: PASS + `pnpm typecheck`。
Step 5: Commit `feat(F033): request_decision kind 三态 MCP 面 + anchorMessageId 断线修复 [黄仁勋]`。

### Task 5: orphan-at-boot + records 查询端点（TDD）

**Files:**
- Modify: `packages/api/src/routes/decision-board.ts`（GET `/api/decisions/records`）
- Modify: `packages/api/src/server.ts`（boot 时 `decisionRecordRepo.orphanAllPending()`；`new DecisionManager(..., repository, decisionRecordRepo)` 接线）
- Test: `packages/api/src/routes/decision-board.test.ts`（fastify inject，参照既有 route test 风格）

Step 1: 失败测试：GET 带 sessionGroupId 返回非 pending records；无参返回空；boot orphan 后 pending 行变 orphaned。
Step 2-4: FAIL → 实现 → PASS。
Step 5: Commit `feat(F033): decisions/records 端点 + 重启 orphan 兜底 [黄仁勋]`。

### Task 6: 前端 store — records 轨 + optimistic resolve（TDD）

**Files:**
- Modify: `components/stores/decision-store.ts`
- Create: `components/stores/decision-store.test.ts`（vitest）
- Modify: `app/page.tsx:63-64`（`decision.resolved` → `resolveFromWs`，替换纯 remove）
- Modify: `components/stores/thread-store.ts:481`（fetchPending 处同步 fetchRecords）

Store 增量：
```ts
records: DecisionRecord[]
fetchRecords: (sessionGroupId: string) => Promise<void>
respond: (...)   // 原 WS send 不动；追加：从 pending 找到请求 → 构造 status:"resolved" record 头插 records（optimistic）
resolveFromWs: (requestId, decisions, userInput?) => void  // 他端/超时 resolve：pending → records；本端已 optimistic 则去重
```
Step 1: vitest 失败测试（respond 后 pending 消失/records 出现；resolveFromWs 去重；fetchRecords 合并不重复）。
Step 2-4: FAIL → 实现 → PASS（`pnpm test:components`）。
Step 5: Commit `feat(F033): decision-store records 轨 + optimistic resolve [黄仁勋]`。

### Task 7: DecisionCard 重构 — 三 kind + resolved disabled 态（TDD）

**Files:**
- Modify: `components/chat/decision-card.tsx`
- Modify/Create: `components/chat/decision-card.test.tsx`（vitest + @testing-library）

结构：`DecisionCard({ request?, record?, onRespond })`：
- live + `fan_in_selector` → FanInCard（**不动**）
- live + `inline_confirmation` → ConfirmCard：title + description 正文（AC3 上下文可视）+ 确认（主色）/取消 两按钮
- live + `multi_choice` → OptionsCard：multiSelect ? 复选 : 单选；**单选点选项只改 selected，不回传**；显式"提交"按钮（未选则 disabled）
- record → ResolvedCard：全部选项渲染、所选高亮（✅/tone 边框）、按钮区替换为状态足注（`resolved`=✅ 已确认 · `timeout`=⏰ 超时自动处理 · `orphaned`=已过期）、`pointer-events` 禁用
- 视觉走 F036 OKLCH token / F030 card tone 语言（`components/theme.ts` 现有 token，不新造色值）

Step 1: 失败组件测试：
```
select 点 radio 不触发 onRespond；点提交才触发且 verdict=approved 单项
multi_select 勾多项提交回传多 verdict
confirm 渲染 description；点确认回传 confirm approved + cancel rejected
record(resolved) 无可点按钮 + 所选高亮
record(orphaned) 显示"已过期"
textarea 内按 Enter 不提交（守卫 AC4 回归面）
```
Step 2-4: FAIL → 实现 → PASS。
Step 5: Commit `feat(F033): DecisionCard 三 kind 渲染 + resolved disabled 态 [黄仁勋]`。

### Task 8: 时间线挂载 resolved records（TDD）

**Files:**
- Modify: `components/chat/timeline-panel.tsx:17-39,140-144`（records 并入：anchorMessageId → inline map；standalone → 按 createdAt 排进时间线）
- Modify: `components/chat/message-bubble.tsx:472-478`（inline 渲染扩展到 record）
- Test: 既有 timeline/message-bubble 测试文件加 case

Step 1: 失败测试（anchored record 渲染进对应气泡；standalone record 渲染在时间线；pending 与 record 同 requestId 时只渲染 pending——去重）。
Step 2-4: FAIL → 实现 → PASS。
Step 5: Commit `feat(F033): 时间线/气泡挂载 resolved 决策卡 [黄仁勋]`。

### Task 9: AC4 IME 守卫（TDD）

**Files:**
- Modify: `components/chat/composer.tsx:553`（Enter 分支加 `&& !e.nativeEvent.isComposing`）
- Modify: `components/chat/composer.test.tsx`（keydown with `nativeEvent.isComposing=true` 不触发发送）

Step 1: 失败测试 → Step 2: FAIL → Step 3: 一行守卫 → Step 4: PASS。
Step 5: Commit `fix(F033): composer 中文 IME Enter 误提交守卫（clowder B3 同族，全库原 0 守卫）[黄仁勋]`。

### Task 10: 收尾门禁

1. 全量 `pnpm typecheck && pnpm test`（api + components）+ biome lint。
2. `quality-gate` skill 自检（愿景对照 AC1-4 + 验证命令输出）。
3. L1 活体证据（AC2 刷新验证）：worktree preview（F033 已分配 api:8803/web:3103）里真调一次 MCP request_decision（confirm + select 各一）→ 选择 → 刷新页面 → 卡片仍在且 disabled → 截图归 `.agents/acceptance/F033/`。**注意 worktree preview 真 DB 在 `.worktrees/F033/.runtime/worktree-preview/data/`。**
4. `acceptance-guardian` 独立验收。
5. `requesting-review` @范德彪（真 Codex），五件套 + 本 plan + feature doc。
6. review GO 后 `merge-gate`。

## 风险与雷区备忘

- **respond/timeout 竞态**：pending Map delete 已互斥 resolve，DB 侧靠 markResolved `WHERE status='pending'` 幂等门双保险。
- **F002 fan_in / Decision Board 零改动**：decision-manager.test.ts 既有回归测试是护栏，全量跑。
- **legacy MCP 调用零回归**：不传 kind = 原路径原语义（timeout 全批不变）。
- **双 repo 陷阱**（session-repository vs drizzle twin）：decision_records 只做 drizzle 单实现，不进 session-repository。
- **测试建库**：一律 createDrizzleDb 真 INIT_SQL（test-schema-faithful），禁手写 mock schema。
- **commit 纪律**：一 Task 一 commit，commit 后 `git rev-parse` 取真 hash；`git commit | tail` 吞退出码 → `>file; echo EXIT=$?`。
