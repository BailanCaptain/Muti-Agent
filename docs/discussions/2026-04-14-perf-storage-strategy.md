# 性能优化存储策略讨论纪要

**Thread ID**: `discussion-perf-storage-2026-04-14` | **日期**: 2026-04-14 | **参与者**: 黄仁勋、范德彪、桂芬

## 背景

系统在多 agent 并发场景下体感卡顿明显。小孙提出疑问：SQLite 是不是性能瓶颈？要不要换 Redis？

## 各方观点

### 黄仁勋（主架构师）
- 完整链路审计：`DB 查询 → 快照构建 → WS 全量推送 → 前端 merge/sort/render`
- 核心判断：SQLite 是帮凶（缺索引/PRAGMA/写锁），但主犯是查询模式和全量快照架构
- 换 Redis 投入产出比极低：花 7-10 天解决 10-30% 的卡顿，方案 A（优化现有）2-3 天解决 80-90%

### 范德彪（Codex）
- 运行态证据补强：主库 41.5MB，messages 1474 条，agent_events 44857 条，0 个自定义索引
- 关键洞察：`agent_events` 写放大是被忽视的大瓶颈
- 工程约束：Optimistic UI 必须配 `client_message_id` 对账机制，否则会引入重复气泡

### 桂芬（Gemini）
- 前端视角：卡顿可能是前端渲染洪峰、状态噪音、反馈断层
- 创意贡献：Optimistic UI、骨架缓存、渲染防抖
- 被说服点：同意"前后端二选一是假命题"，全量快照才是同时压死后端和前端的大山

## 共识

1. **第一刀不是换库**，而是降低 `active-group / room-context` 的全量重建频率
2. 主聊天链路从"全量快照"收敛到**增量同步（Tail Tracking）**
3. `agent_events` 做**分级存储/限流/降采样/滑窗展示**
4. 前端 `Render Throttling` 是保险丝，不是主修复
5. `Optimistic UI` 只用于**用户发消息**，不用于 agent 输出流
6. 乐观 UI 配套 `client_message_id / request_id` 对账
7. Redis 的合理位置是**后续缓存层/事件层**，不是当前直接替换主存储

## 分歧

实质性架构分歧已消失。残余执行细节待定：
- `Tail Tracking` 的窗口和补丁边界
- `agent_events` 哪些必须持久化，哪些可 TTL/内存态
- 需要 profile 量化确认各段耗时占比

## 行动项（Phase 分批）

### Phase 0（半天）：观测 + 基准线
- 热路径插桩（`emitThreadSnapshot`/`getActiveGroup`/`listMessages`）
- 定 P90 快照延迟基准线，目标 < 200ms

### Phase 1（1-2 天）：低风险高收益
1. SQLite 索引 + PRAGMA 补全
2. N+1 查询治理（JOIN 重写）
3. `agent_events` 降采样/批量写入

### Phase 2（2-3 天）：架构级
4. `emitThreadSnapshot` → Tail Tracking 增量协议
5. 前端增量 merge + 渲染节流
6. Optimistic UI + `client_message_id` 对账

### Phase 3（待复测后决定）
7. 骨架缓存（LocalStorage/IndexedDB）
8. Redis 缓存层（如仍有存储瓶颈）

## 数据安全约束

**小孙明确要求：整个优化过程中不能删除或改变原始数据。** 所有操作只做"加法"（加索引、加缓存、加新协议），不做"减法"。

## 收敛检查

1. 否决理由 → ADR？**有** → 已写 `docs/discussions/ADR-001-reject-redis-as-primary-store.md`
2. 踩坑教训 → lessons-learned？**有** → 已追加 LL-016
3. 操作规则 → 指引文件？**有** → 数据安全约束已记录

## 追溯链

- 讨论纪要 → `docs/discussions/2026-04-14-perf-storage-strategy.md`（本文）
- ADR → `docs/discussions/ADR-001-reject-redis-as-primary-store.md`
- Feature → `docs/features/F009-perf-optimization.md`（待立项）
- Lessons → `docs/lessons/lessons-learned.md` LL-016
