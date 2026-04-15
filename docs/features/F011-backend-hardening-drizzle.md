---
id: F011
title: 后端加固 + drizzle-orm 迁移 — 数据库/WebSocket/事件系统健壮性 + ORM 一步到位
status: done
owner: 黄仁勋
created: 2026-04-14
completed: 2026-04-15
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
- [x] AC-01: 安装 drizzle-orm + better-sqlite3 + drizzle-kit 依赖
- [x] AC-02: 定义 drizzle schema（`packages/api/src/db/schema.ts`），覆盖所有现有表：session_groups、threads、messages、invocations、agent_events、session_memories、tasks、authorization_rules、authorization_audit
- [x] AC-03: 核心表加外键约束：messages.thread_id → threads.id、invocations.thread_id → threads.id、agent_events.invocation_id → invocations.id（BUG-13）
- [x] AC-04: INIT_SQL + CREATE TABLE IF NOT EXISTS 建表，确认迁移可在现有数据库上无损执行
- [x] AC-04b: 迁移前自动备份（`ensurePreMigrationBackup`）+ 回滚脚本（`rollbackDatabase`）+ 备份完整性校验
- [x] AC-05: 删除 `sqlite.ts` 中所有 try-catch 式伪迁移（11 处 ALTER TABLE 全清），改为 INIT_SQL 正式建表（BUG-12）
- [ ] ~~AC-06: 用 Worker Thread 包装 better-sqlite3~~ **DEFERRED** — Node v24 无 better-sqlite3 预编译 binary。改用 node:sqlite 适配层 + drizzle 查询构建器
- [ ] ~~AC-06b: Repository sync→async 适配~~ **DEFERRED** — 依赖 AC-06

### Phase 2：Repository 迁移（2-3 天）
- [x] AC-07: `session-repository-drizzle.ts`（614 行）全量 drizzle 查询构建器
- [x] AC-08: 所有多步写操作加事务包裹（`runTx()`），含 eventBus 4 个监听器（BUG-5）
- [x] AC-09: MemoryService N+1 查询治理：JOIN 替换循环查询（BUG-6）
- [x] AC-10: 所有 list*/search* 查询加 LIMIT（按 group 数截断，非行数）（BUG-7）
- [x] AC-11: `authorization-rule-repository-drizzle.ts` 迁移完成
- [x] AC-12: 全量测试绿（513/513 pass，数据库行为不变）

### Phase 3：WebSocket + 事件系统修复（半天）
- [x] AC-13: `ws.ts` 加 ping/pong 心跳（30s 间隔）+ 超时断开半开连接（90s 无 pong）（BUG-8）
- [x] AC-14: `server.ts` eventBus 监听器在 Fastify onClose hook 中 off() 清理（BUG-9）
- [x] AC-15: WS 断开后 `sockets.size` 正确回收

### 门禁
- [x] AC-16: `pnpm typecheck && pnpm test` 全绿（513/513 tests, 0 errors）
- [x] AC-17: N+1 消除已通过代码审查确认（JOIN 替换循环查询）
- [x] AC-18: WS 心跳 + 超时断开已通过代码审查确认

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 数据库驱动 | A: node:sqlite / B: better-sqlite3 | A（实际） | 原定 B，但 Node v24 无预编译 binary + native 编译失败。改用 node:sqlite + 适配层兼容 drizzle better-sqlite3 driver |
| ORM 选型 | A: 无 ORM / B: drizzle-orm / C: prisma | B | 类型安全 + 轻量 + 正式迁移管理 |
| 异步方案 | A: 主线程同步 / B: Worker Thread | A（deferred B） | Worker Thread 依赖 better-sqlite3，Node v24 不可用。当前同步方案可接受，待条件具备回补 |
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
| 2026-04-15 | Spec 审阅 | 黄仁勋对比代码审阅：修正表清单（config→authorization_audit）、补 AC-04b 回滚策略、补 AC-06b sync→async 适配、扩展 AC-08 事务路径（+4 条）、扩展 AC-10 分页范围（+3 个查询）、细化 AC-14 eventBus 清理 |
| 2026-04-15 | 实施计划 | 黄仁勋编写 20 步分步实施计划，3 Phase + 门禁，预估 4.5-6 天。见 [implementation plan](../plans/F011-implementation-plan.md) |
| 2026-04-15 | AC-06 deferred | 黄仁勋决定：Node v24 无 better-sqlite3 预编译 binary，Worker Thread 方案 deferred。改用 node:sqlite 适配层，同步但通过 drizzle 查询构建器获得类型安全。待条件具备回补 |
| 2026-04-15 | 开发完成 | 5 commits，21 files，+2800/-269 行。513 tests 全绿 |
| 2026-04-15 | 桂芬验收 | 一轮 BLOCKED（4 项）→ 修复 → 二轮 PASS |
| 2026-04-15 | 范德彪 review | 一轮 2 findings → 修复 → 二轮 2 findings → 修复 → 放行 |
| 2026-04-15 | 合入 dev | squash merge `ae5f5db`，status → completed |

## Implementation Plan

详细分步实施计划见 [F011-implementation-plan.md](../plans/F011-implementation-plan.md)，包含：
- 20 步分步执行方案（含 TDD 红绿重构）
- 3 Phase 关卡检查点
- 依赖关系图
- 风险与缓解矩阵
- 时间估算：4.5-6 天

## Links

- F009: 性能优化（已修 N+1 的 listSessionGroups，本次继续治理 MemoryService）
- F010: 基线回绿（前置依赖）

## Evolution

- **Depends on**: F010（基线回绿）
- **Blocks**: 调度状态持久化（后续立项，依赖 drizzle schema）
- **Parallel**: F012（前端加固）、F013（CI 门禁）
