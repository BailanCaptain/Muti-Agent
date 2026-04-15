# F011 实施计划 — 后端加固 + drizzle-orm 迁移

**Created**: 2026-04-15
**Owner**: 黄仁勋
**Spec**: [F011-backend-hardening-drizzle.md](../features/F011-backend-hardening-drizzle.md)

---

## 前置条件

- F010（基线回绿）已完成 ✅
- `pnpm typecheck && pnpm test` 全绿 ✅
- 开发使用 worktree 隔离，不影响 dev 分支和 F012 并行开发

---

## 影响面摘要

| 文件 | 行数 | 改动性质 |
|------|------|----------|
| `db/sqlite.ts` | 270 | **重写** — DatabaseSync → drizzle + better-sqlite3 |
| `db/repositories/session-repository.ts` | 568 | **重写** — 裸 SQL → drizzle 查询构建器，sync → async |
| `db/repositories/authorization-rule-repository.ts` | 91 | **重写** — 同上 |
| `db/repositories/index.ts` | - | 更新导出 |
| `storage/sqlite.ts` + `storage/repositories.ts` | 2 | re-export，跟随更新 |
| `services/memory-service.ts` | 320 | **重构** — N+1 → JOIN/batch，sync → async |
| `mcp/server.ts` | 768 | **适配** — eventBus off() 清理 + 调用方 await |
| `routes/ws.ts` | 119 | **增强** — 加 ping/pong 心跳 |
| `events/event-bus.ts` | 18 | 不变 |
| 测试文件（多个） | - | **更新** — 适配 async 接口 |

---

## Phase 1：drizzle-orm 基础设施（AC-01 ~ AC-06b）

### Step 1. 开 worktree + 安装依赖（AC-01）

**做什么**：
1. `git worktree add ../Multi-Agent-F011 dev` 创建隔离工作区
2. 安装三个新依赖：
   ```bash
   pnpm add drizzle-orm better-sqlite3 -w --filter @multi-agent/api
   pnpm add -D drizzle-kit @types/better-sqlite3 -w --filter @multi-agent/api
   ```
3. 在 `packages/api/` 创建 `drizzle.config.ts`

**检查点**：`pnpm typecheck` 通过（纯加依赖，不应破坏）

---

### Step 2. 数据库备份机制（AC-04b）

**做什么**：
1. 创建 `packages/api/src/db/backup.ts`
   - `backupDatabase(dbPath: string): string` — 在同目录创建 `{name}.backup-{ISO时间戳}.db`
   - 返回备份文件路径
2. 在数据库初始化流程中，迁移前调用备份

**TDD**：
- RED: 测试 `backupDatabase` 对临时文件创建备份并验证内容一致
- GREEN: 实现 `fs.copyFileSync`
- REFACTOR: 无

**检查点**：测试绿

---

### Step 3. drizzle schema 定义（AC-02）

**做什么**：
1. 创建 `packages/api/src/db/schema.ts`
2. 定义 9 张表的 drizzle schema：
   - `sessionGroups` — id, currentProvider, projectTag, defaultModels, createdAt, updatedAt
   - `threads` — id, sessionGroupId(FK→sessionGroups), provider, alias, currentModel, nativeSessionId, sopBookmark, lastFillRatio, updatedAt
   - `messages` — id, threadId(FK→threads), role, content, thinking, messageType, connectorSource, groupId, groupRole, toolEvents, contentBlocks, createdAt
   - `invocations` — id, threadId(FK→threads), agentId, callbackToken, status, startedAt, finishedAt
   - `agentEvents` — id, invocationId(FK→invocations), type, data, timestamp
   - `sessionMemories` — id, sessionGroupId(FK→sessionGroups), type, content, embedding, updatedAt
   - `tasks` — id, sessionGroupId(FK→sessionGroups), title, status, assignee, createdAt, updatedAt
   - `authorizationRules` — id, agentId, toolPattern, verdict, expiresAt, scope
   - `authorizationAudit` — id, agentId, toolName, verdict, ruleId, timestamp

**TDD**：
- RED: 测试 schema 导出包含所有 9 张表
- GREEN: 定义 schema
- REFACTOR: 确认字段类型与现有 `sqlite.ts` 中的类型定义一致

**关键约束**：
- 字段名必须与现有数据库列名**完全一致**（用 `.column_name()` 映射）
- 只做加法，不删列不改类型

**检查点**：`pnpm typecheck` 通过

---

### Step 4. 外键约束（AC-03）

**做什么**：
- 在 Step 3 的 schema 中已经通过 `.references()` 声明了外键
- 此步骤确认外键关系正确：
  - `messages.threadId → threads.id`
  - `invocations.threadId → threads.id`
  - `agentEvents.invocationId → invocations.id`
  - `threads.sessionGroupId → sessionGroups.id`
  - `sessionMemories.sessionGroupId → sessionGroups.id`
  - `tasks.sessionGroupId → sessionGroups.id`

**注意**：SQLite 外键需要 `PRAGMA foreign_keys = ON`，在连接初始化时设置

**检查点**：drizzle-kit introspect 输出与 schema 一致

---

### Step 5. drizzle-kit 迁移（AC-04, AC-05）

**做什么**：
1. 创建 `drizzle.config.ts` 配置文件
2. `npx drizzle-kit generate` 生成初始迁移
3. 审查生成的 SQL — 确认只有 ADD COLUMN / CREATE INDEX / ADD CONSTRAINT，没有 DROP 或 ALTER TYPE
4. 编写迁移执行逻辑：备份 → `drizzle-kit migrate` → 验证
5. 删除 `sqlite.ts` 中所有 try-catch 式伪迁移代码

**TDD**：
- RED: 测试在空数据库上执行迁移后所有表和列存在
- GREEN: 执行 drizzle-kit migrate
- REFACTOR: 无

**风险控制**：
- 迁移前自动调用 Step 2 的备份
- 在 54MB 测试数据库上验证迁移耗时和数据完整性
- 确认 `better-sqlite3` 能正确读取 `node:sqlite` 创建的数据库文件

**检查点**：`npx drizzle-kit check` 通过，现有数据库可无损迁移

---

### Step 6. Worker Thread 包装（AC-06）

**做什么**：
1. 创建 `packages/api/src/db/worker.ts` — Worker 端，加载 better-sqlite3 并执行同步查询
2. 创建 `packages/api/src/db/db-client.ts` — 主线程端，通过 `worker_threads` 发送查询、返回 Promise
3. API 设计：
   ```typescript
   export class DbClient {
     constructor(dbPath: string)
     query<T>(sql: string, params?: unknown[]): Promise<T[]>
     run(sql: string, params?: unknown[]): Promise<{ changes: number }>
     transaction<T>(fn: (tx: Transaction) => T): Promise<T>
     close(): Promise<void>
   }
   ```

**TDD**：
- RED: 测试 DbClient.query 返回 Promise 并包含正确数据
- RED: 测试 DbClient.transaction 在错误时回滚
- GREEN: 实现 Worker Thread 通信
- REFACTOR: 错误传播（Worker 异常序列化回主线程）

**检查点**：DbClient 单元测试全绿

---

### Step 7. drizzle 实例初始化（AC-06 续）

**做什么**：
1. 创建 `packages/api/src/db/drizzle-instance.ts`
   - 初始化 better-sqlite3 连接
   - `PRAGMA foreign_keys = ON`
   - `PRAGMA journal_mode = WAL`
   - 创建 drizzle 实例 `drizzle(betterSqlite3Db, { schema })`
2. 将 Worker Thread 与 drizzle 集成
3. 更新 `db/sqlite.ts` 的 `SqliteStore` — 内部改用 drizzle，但暂时保留旧的外部接口（为 Step 9 渐进迁移做准备）

**检查点**：drizzle 实例可以成功查询现有数据库

---

### Step 8. Repository 接口 sync→async（AC-06b）

**做什么**：
1. 将 `SessionRepository` 的 23 个方法签名全部从 sync 改为 async（返回 Promise）
2. 将 `AuthorizationRuleRepository` 的方法签名改为 async
3. 更新所有调用方加 `await`：
   - `mcp/server.ts` — MCP tool handlers
   - `services/memory-service.ts` — summarize/getOrCreate 等
   - `services/message-service.ts`（如涉及）
   - `routes/` 下各路由
   - `orchestrator/` 下引用 repository 的模块
   - 测试文件
4. 内部实现暂时用 `Promise.resolve()` 包裹旧同步逻辑，保证编译通过

**这是影响面最大的一步**，涉及几乎所有 import SessionRepository 的文件。策略：
- 先改接口签名 + 所有调用方 await
- 内部实现用 `Promise.resolve(旧同步代码)` 过渡
- Phase 2 再逐个替换内部实现为真正的 drizzle 异步查询

**TDD**：
- RED: 修改接口签名后 typecheck 必然报错
- GREEN: 逐文件加 await 直到 typecheck 通过
- REFACTOR: 确认所有测试通过（行为不变，只是 Promise 包裹）

**检查点**：`pnpm typecheck && pnpm test` 全绿 ← **Phase 1 大关卡**

---

## Phase 2：Repository 迁移（AC-07 ~ AC-12）

### Step 9. SessionRepository 基础查询迁移（AC-07 前半）

**做什么**：将 getter/lister 类方法从裸 SQL 迁移到 drizzle 查询构建器：
- `getSessionGroupById` → `db.select().from(sessionGroups).where(eq(...))`
- `getThreadById` → `db.select().from(threads).where(eq(...))`
- `getInvocationById` / `getInvocationByCredentials`
- `listSessionGroups` → 加 LIMIT
- `listThreadsByGroup`
- `listMessages` / `listMessagesSince` / `listRecentMessages` → 加 LIMIT
- `getLatestMemory`

**TDD**：逐个方法迁移，每迁移一个跑一次测试（先红后绿）

**检查点**：所有 getter/lister 测试绿

---

### Step 10. SessionRepository 写操作迁移（AC-07 后半）

**做什么**：将 creator/updater 类方法迁移到 drizzle：
- `createSessionGroup` / `createThread` / `appendMessage`
- `createInvocation` / `appendAgentEvent`
- `createMemory` / `createTask`
- `updateSessionGroupProjectTag` / `updateThread` / `updateInvocation`
- `overwriteMessage`
- `ensureDefaultThreads` / `reconcileLegacyDefaultModels`

**检查点**：所有写操作测试绿

---

### Step 11. 事务包裹 — 核心路径（AC-08）

**做什么**：用 `db.transaction()` 包裹以下 5 条多步写路径：

1. **`createSessionGroup` + `ensureDefaultThreads`**
   ```typescript
   await db.transaction(async (tx) => {
     const group = await tx.insert(sessionGroups).values({...}).returning();
     for (const provider of PROVIDERS) {
       await tx.insert(threads).values({ sessionGroupId: group.id, ... });
     }
   });
   ```

2. **`touchThread`**（L473-485）
   - UPDATE thread.updatedAt → SELECT thread → UPDATE session_group.updatedAt
   - 3 步包进一个事务

3. **`overwriteMessage`**（L295-307）
   - SELECT existing → UPDATE content
   - 读写原子化

4. **`reconcileLegacyDefaultModels`**（L450-471）
   - 循环 PROVIDERS 逐个 UPDATE
   - 事务保证全部成功或全部回滚

5. **eventBus invocation 监听器**（server.ts L129-208）
   - 4 个监听器各有 createInvocation/updateInvocation + appendAgentEvent 两步写
   - 每个包进事务

**TDD**：
- RED: 测试事务中间故意抛错，验证数据回滚
- GREEN: 加 `db.transaction()` 包裹
- REFACTOR: 提取通用的事务包裹模式

**检查点**：事务回滚测试 + 正常路径测试全绿

---

### Step 12. MemoryService N+1 治理（AC-09）

**做什么**：
- 当前 `getOrCreateSummary()` 最坏路径：3 × `listThreadsByGroup` + 3N × `listMessages` = **3+3N** 次查询
- 改为 drizzle JOIN 查询：
  ```typescript
  const threadsWithMessages = await db
    .select()
    .from(threads)
    .leftJoin(messages, eq(messages.threadId, threads.id))
    .where(eq(threads.sessionGroupId, groupId))
    .orderBy(messages.createdAt);
  ```
- 将 `summarizeSession()` / `generateRollingSummary()` 的 N+1 同样改为 batch/JOIN

**TDD**：
- RED: 测试 summary 生成只执行 ≤3 次 SELECT（mock db 计数）
- GREEN: 用 JOIN 替换循环查询
- REFACTOR: 优化数据分组逻辑

**检查点**：N+1 测试 + 现有 memory-service 测试全绿

---

### Step 13. list*/search* 分页（AC-10）

**做什么**：给以下 4 个查询加 LIMIT + offset 分页：
1. `listMessages` — 默认 LIMIT 200
2. `listSessionGroups` — 默认 LIMIT 50
3. `listMemories` — 默认 LIMIT 100
4. `searchMemories` — 默认 LIMIT 50

接口变更：
```typescript
listMessages(threadId: string, opts?: { limit?: number; offset?: number }): Promise<MessageRecord[]>
```

**TDD**：
- RED: 测试插入 300 条消息，`listMessages()` 默认只返回 200 条
- GREEN: 加 `.limit().offset()`
- REFACTOR: 统一分页参数类型

**检查点**：分页测试绿

---

### Step 14. AuthorizationRuleRepository 迁移（AC-11）

**做什么**：
- 将 `authorization-rule-repository.ts` 的裸 SQL 迁移到 drizzle
- 方法：list / create / delete / findMatching 等
- sync → async 已在 Step 8 完成，此步只替换内部实现

**检查点**：authorization 相关测试绿

---

### Step 15. 清理旧代码 + 全量回归（AC-12）

**做什么**：
1. 删除 `sqlite.ts` 中旧的 `DatabaseSync` 初始化代码和 `SqliteStore` 类型（如不再被引用）
2. 更新 `storage/sqlite.ts` 和 `storage/repositories.ts` 的 re-export
3. 清理所有已废弃的类型定义（`ProviderThreadRecord` 等如果 drizzle infer 替代了）
4. `pnpm typecheck && pnpm test` 全量回归

**检查点**：`pnpm typecheck && pnpm test` 全绿 ← **Phase 2 大关卡**

---

## Phase 3：WebSocket + 事件系统修复（AC-13 ~ AC-15）

### Step 16. WebSocket ping/pong 心跳（AC-13）

**做什么**：
在 `routes/ws.ts` 的 `registerWsRoute` 中：
1. 连接建立后启动 30s 间隔的 `socket.ping()` 定时器
2. 监听 `pong` 事件，标记连接为活跃
3. 如果 90s 内无 pong 响应，`socket.terminate()` + 从 `sockets` Set 移除
4. `socket.on('close')` 中清理定时器

```typescript
const heartbeatInterval = setInterval(() => {
  if (!isAlive) { socket.terminate(); sockets.delete(socket); return; }
  isAlive = false;
  socket.ping();
}, 30_000);

socket.on('pong', () => { isAlive = true; });
socket.on('close', () => { clearInterval(heartbeatInterval); sockets.delete(socket); });
```

**TDD**：
- RED: 测试 90s 无 pong 后连接被清理
- GREEN: 实现心跳逻辑
- REFACTOR: 无

**检查点**：ws 测试绿

---

### Step 17. eventBus 监听器清理（AC-14）

**做什么**：
在注册 eventBus 监听器的地方（server.ts 或对应模块），保存 listener 引用并在 Fastify `onClose` hook 中 `off()`：

```typescript
const listeners = {
  created: (e) => { /* ... */ },
  updated: (e) => { /* ... */ },
  completed: (e) => { /* ... */ },
  error: (e) => { /* ... */ },
};

eventBus.on('invocation.created', listeners.created);
eventBus.on('invocation.updated', listeners.updated);
eventBus.on('invocation.completed', listeners.completed);
eventBus.on('invocation.error', listeners.error);

app.addHook('onClose', () => {
  eventBus.off('invocation.created', listeners.created);
  eventBus.off('invocation.updated', listeners.updated);
  eventBus.off('invocation.completed', listeners.completed);
  eventBus.off('invocation.error', listeners.error);
});
```

**TDD**：
- RED: 测试 app.close() 后 eventBus listener count 归零
- GREEN: 实现 off() 清理
- REFACTOR: 无

**检查点**：事件系统测试绿

---

### Step 18. WS 连接回收验证（AC-15）

**做什么**：
- 手动测试：浏览器连接 WS → 关闭浏览器 → 检查 `sockets.size` 日志
- 加一条 debug 日志输出当前连接数

**检查点**：`sockets.size` 正确递减

---

## 门禁（AC-16 ~ AC-18）

### Step 19. 全量回归

```bash
pnpm typecheck && pnpm test
```

必须全绿。

### Step 20. 手动验证

1. **N+1 消除**：启动 dev server → 触发 summary 生成 → 日志中单次 summary 只有 1-2 条 SELECT
2. **WS 半开清理**：浏览器连接 → 断网/关标签 → 90s 内 server 日志显示连接清理
3. **drizzle 迁移**：在 54MB 数据库上执行迁移 → 验证数据完整 → 验证回滚脚本可用

---

## 依赖关系图

```
Step 1 (worktree + 依赖)
  ↓
Step 2 (备份) ──→ Step 5 (迁移，需要备份)
  ↓
Step 3 (schema) → Step 4 (外键) → Step 5 (迁移)
                                      ↓
                              Step 6 (Worker Thread)
                                      ↓
                              Step 7 (drizzle 实例)
                                      ↓
                              Step 8 (sync→async) ← Phase 1 关卡
                                      ↓
                    ┌─────────────────┼─────────────────┐
                    ↓                 ↓                 ↓
              Step 9 (读)      Step 14 (auth)    Step 16 (WS)
                    ↓                                   ↓
              Step 10 (写)                       Step 17 (eventBus)
                    ↓                                   ↓
              Step 11 (事务)                     Step 18 (验证)
                    ↓
              Step 12 (N+1)
                    ↓
              Step 13 (分页)
                    ↓
              Step 15 (清理) ← Phase 2 关卡
                                      ↓
                              Step 19 (全量回归)
                                      ↓
                              Step 20 (手动验证) ← 完成
```

**注意**：Phase 2 中 Step 9-13 必须顺序执行（后者依赖前者的 drizzle 迁移）。Phase 3 的 Step 16-17 可在 Phase 2 完成后并行。

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| better-sqlite3 无法读取 node:sqlite 创建的 DB | 低 | 高 | Step 5 在 54MB 真实 DB 上验证 |
| sync→async 级联改动量超预期 | 中 | 中 | Step 8 先 Promise.resolve 包裹过渡 |
| drizzle-kit 生成的迁移包含破坏性 SQL | 低 | 高 | Step 5 人工审查每条 SQL |
| Worker Thread 序列化开销抵消异步收益 | 低 | 中 | Step 6 benchmark 对比 |
| 外键约束导致现有数据不满足（orphan rows） | 中 | 中 | 迁移前查询 orphan 记录并清理 |

---

## 时间估算

| Phase | 预估 | 关键路径 |
|-------|------|----------|
| Phase 1（Step 1-8） | 1.5-2 天 | Step 8 sync→async 级联 |
| Phase 2（Step 9-15） | 2-3 天 | Step 11 事务 + Step 12 N+1 |
| Phase 3（Step 16-18） | 0.5 天 | 无阻塞 |
| 门禁（Step 19-20） | 0.5 天 | 手动验证 |
| **总计** | **4.5-6 天** | |
