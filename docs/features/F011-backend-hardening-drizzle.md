---
id: F011
title: 后端加固 + drizzle-orm 迁移 — 数据库/WebSocket/事件系统健壮性 + ORM 一步到位
status: spec
owner: 黄仁勋
created: 2026-04-14
---

# F011 — 后端加固 + drizzle-orm 迁移

**Created**: 2026-04-14

## Why

三方审计发现后端存在多层面的健壮性问题：

1. **数据库**：多步写无事务保护（写一半崩了留孤儿数据）、N+1 查询（MemoryService 3×N 次 SELECT）、listMessages 无 LIMIT（全量加载到内存）、迁移靠 try-catch 猜"列是否存在"、无外键约束
2. **WebSocket**：半开连接无超时清理（内存慢慢泄漏）
3. **事件系统**：eventBus 监听器热重启累积
4. **架构**：`node:sqlite` 的 `DatabaseSync` 同步阻塞事件循环，54MB 数据库 + 同步查询 = 用户可感知卡顿

村长已选定 **drizzle-orm + better-sqlite3** 方案。既然要换 ORM，不如一步到位：直接用 drizzle 重写时把事务、LIMIT、外键、正式迁移管理全带上，避免同一批文件改两遍。

### 讨论来源

- 全面排查讨论综合报告
- 分歧点决议：DatabaseSync 迁移 → [B] drizzle-orm + better-sqlite3（村长已定）

### 数据安全约束（铁律）

- 所有 schema 变更只做"加法"（加索引、加列、加表、加约束）
- 不删表、不删列、不清数据
- drizzle-kit migrate 前必须确认不影响现有数据
- 迁移必须可回滚

## Acceptance Criteria

### Phase 1：drizzle-orm 基础设施（1-2 天）
- [ ] AC-01: 安装 drizzle-orm + better-sqlite3 + drizzle-kit 依赖
- [ ] AC-02: 定义 drizzle schema（`packages/api/src/db/schema.ts`），覆盖所有现有表：session_groups、threads、messages、invocations、agent_events、session_memories、tasks、authorization_rules、config
- [ ] AC-03: 核心表加外键约束：messages.thread_id → threads.id、invocations.thread_id → threads.id、agent_events.invocation_id → invocations.id（BUG-13）
- [ ] AC-04: 用 drizzle-kit generate 生成初始迁移文件，确认迁移可在现有 54MB 数据库上无损执行
- [ ] AC-05: 删除 `sqlite.ts` 中所有 try-catch 式伪迁移（ALTER TABLE ... catch ignore），改为 drizzle-kit 正式版本管理（BUG-12）
- [ ] AC-06: 用 Worker Thread 包装 better-sqlite3，主线程不再同步阻塞

### Phase 2：Repository 迁移（2-3 天）
- [ ] AC-07: `session-repository.ts` 所有裸 SQL 迁移为 drizzle 查询构建器
- [ ] AC-08: 多步写操作加事务包裹：createSessionGroup + ensureDefaultThreads 等关键路径用 `db.transaction()`（BUG-5）
- [ ] AC-09: MemoryService N+1 查询治理：3×N 次循环 SELECT 改为 drizzle 的 JOIN / batch 查询（BUG-6）
- [ ] AC-10: listMessages / listSessionGroups 加 LIMIT + offset 分页（BUG-7）
- [ ] AC-11: 其余 repository（config-repo、memory-repo 等）裸 SQL 迁移完成
- [ ] AC-12: 全量测试绿（所有现有测试通过，数据库行为不变）

### Phase 3：WebSocket + 事件系统修复（半天）
- [ ] AC-13: `ws.ts` 加 ping/pong 心跳（30s 间隔）+ 超时断开半开连接（90s 无 pong）（BUG-8）
- [ ] AC-14: `server.ts` eventBus 监听器在 Fastify onClose hook 中 off() 清理（BUG-9）
- [ ] AC-15: WS 断开后 `sockets.size` 正确回收（手动验证）

### 门禁
- [ ] AC-16: `pnpm typecheck && pnpm test` 全绿
- [ ] AC-17: 手动验证：summary 生成不再 N+1（日志中单次 summary 只有 1-2 条 SELECT）
- [ ] AC-18: 手动验证：浏览器断开 WS 后 90s 内 server 清理连接

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 数据库驱动 | A: node:sqlite / B: better-sqlite3 | B | better-sqlite3 比 node:sqlite 快 2-5x，社区更成熟 |
| ORM 选型 | A: 无 ORM / B: drizzle-orm / C: prisma | B | 类型安全 + 轻量 + 支持 better-sqlite3 + 正式迁移管理 |
| 异步方案 | A: 主线程同步 / B: Worker Thread | B | 同步阻塞是最大架构瓶颈，Worker 解耦主线程 |
| 事务范围 | A: 全局事务 / B: 按业务逻辑包裹 | B | 只在多步写路径加事务，避免锁竞争 |
| 外键约束 | A: 应用层保证 / B: DB 层 FK | B | 应用层 bug 无法拦截，DB 层是最后防线 |

## 技术方案概要

### 1. drizzle schema 定义
```typescript
// packages/api/src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  sessionGroupId: text('session_group_id').references(() => sessionGroups.id),
  // ...
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').references(() => threads.id),
  // ...
});
```

### 2. Worker Thread 架构
```
Main Thread                    Worker Thread
  │                               │
  ├── db.query(sql) ──────────►  │ better-sqlite3.exec(sql)
  │   (async, non-blocking)       │ (sync, but isolated)
  ◄── Promise<result> ──────────  │
  │                               │
```

### 3. 事务包裹示例
```typescript
await db.transaction(async (tx) => {
  const group = await tx.insert(sessionGroups).values({...}).returning();
  await tx.insert(threads).values({ sessionGroupId: group.id, ... });
});
```

## 验证命令

```bash
# 全量回归
pnpm typecheck && pnpm test

# drizzle 迁移检查
npx drizzle-kit check

# 手动验证 N+1 消除
# 启动 dev server，触发 summary 生成，观察日志中 SELECT 次数
```

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | 三方审计 | BUG-5/6/7/8/9/12/13 + A1 架构隐忧 |
| 2026-04-14 | 村长决定 | DatabaseSync 迁移选 [B] drizzle-orm |
| 2026-04-14 | F011 立项 | 后端加固 + drizzle 合并为一个 feature |

## Links

- F009: 性能优化（已修 N+1 的 listSessionGroups，本次继续治理 MemoryService）
- F010: 基线回绿（前置依赖）

## Evolution

- **Depends on**: F010（基线回绿）
- **Blocks**: 调度状态持久化（后续立项，依赖 drizzle schema）
- **Parallel**: F012（前端加固）、F013（CI 门禁）
