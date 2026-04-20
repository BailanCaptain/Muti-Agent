---
id: F022
title: 左侧 Sidebar 重设计 — 全局递增 ROOM ID + Haiku 自动命名 + 反向溯源
status: spec
owner: 黄仁勋
created: 2026-04-19
---

# F022 — 左侧 Sidebar 重设计

**Created**: 2026-04-19

## Why

当前 `session-sidebar.tsx` 的房间命名是**自动带日期前缀**（`2026-04-18 14:30 · 未命名`），分组依赖 `projectTag`（多数落在"未分组"），回溯只靠搜索框 + preview 文本：

> 小孙："左侧全是新会话带日期好难看。如果我想日后找到某个房间的聊天记录当证据给某个 agent 定位，可能就难找了。"

这是**反向溯源**场景，需要三把索引：**时间 · agent · 语义**。现在只有语义搜索一把钥匙，且标题还无语义。

### 讨论来源

- 本轮 collaborative-thinking（2026-04-18）黄仁勋提出四件套方案
- 产品（小孙）拍板两个关键决策（见 Design Decisions）
- 设计图：
  - `docs/left-sidebar-redesign-huang.png`（双视图对比）
  - `docs/header-id-patch-huang.png`（标题栏三层 ID 补丁）

## What

两件事：**稳定可引用的 ROOM ID** + **语义化自动命名**。

1. **全局递增 ROOM ID** — `R-001`, `R-002`, ... 像 GitHub Issue，不按 projectTag 分号，跨项目可引用
2. **Haiku 自动命名** — 首条 user 消息 + 首条 assistant 回复之后（等 2-3 秒），用 Haiku 总结 session 主题写入 title
3. **左侧 sidebar 条目结构**：`R-xxx · {语义 title}` + 时间戳 + agent 头像堆叠（谁参与了这个房间）
4. **反向溯源**：搜索框支持 `R-042` 直跳；agent 头像作为索引可过滤"范德彪参与过的房间"
5. **标题栏三层 ID 补丁**：右侧面板 ROOM 徽章 + 聊天头 + 消息元数据都显示 `R-xxx`，可复制引用

## Acceptance Criteria

### Phase 1：ROOM ID 生成 + 存储（0.5 天）
- [x] AC-01: 新建 session 时分配全局递增 ID：`R-001`, `R-002`, ...
- [x] AC-02: ID 持久化到 session 记录（`session_groups.room_id` 字段）
- [x] AC-03: 历史 session 回填（`backfillRoomIds` 启动时幂等执行，按 createdAt 升序分配）
- [x] AC-04: ID 在数据库层面全局唯一（`CREATE UNIQUE INDEX idx_session_groups_room_id`）

### Phase 2：Haiku 自动命名（1 天）
- [x] AC-05: 触发时机：assistant final 消息后 debounce 2.5s（SessionTitler.schedule 合并多次调用）
- [x] AC-06: 调用 Haiku（claude-haiku-4-5）总结 session，生成简短 title（≤ 10 字）
- [x] AC-07: 命名结果写入 session_groups.title，替换原有 `YYYY-MM-DD · 未命名` 格式
- [x] AC-08: Haiku 失败时回退到 `新会话 YYYY-MM-DD`（不阻塞；timeout/exit-code/empty-output/spawn-error 四类失败统一处理）
- [x] AC-09: 命名过程不阻塞用户输入（schedule 同步返回，setTimeout + .unref() 不阻塞进程退出）
- [x] AC-10: 已命名过的 session 不重复命名（通过 `isDefaultTitle` 正则匹配默认模式实现幂等）

### Phase 3：Sidebar UI 重塑（1 天）
- [x] AC-11: 条目显示 `R-xxx · {语义 title}`（等宽琥珀色前缀 + 中点分隔）
- [x] AC-12: 条目下方显示 agent 头像堆叠（participants = 发过消息的 provider，不含空 thread）
- [x] AC-13: 搜索框输入 `R-042` 直跳（`/^R-?0*\d+$/i` 三形态识别 + 自动 selectGroup + 空结果提示）
- [~] AC-14: ~~搜索支持 agent 过滤（头像 pills，多选 AND 过滤参与房间）~~ **Dropped 2026-04-20** — 小孙 worktree 预览验收判定"用处不大"，按产品反馈删除实现
- [x] AC-15: 条目悬停显示完整信息（原生 title 属性：创建 · 最后活动 · N 条消息）

### Phase 3.5：预览验收反馈补丁（2026-04-20 小孙 worktree 验收发现）
- [ ] AC-14a: 时间分组替换 projectTag 分组（置顶 / 今日 / 本周 / 本月 / 更早）—— projectTag 多数落"未分组"不承载索引价值，时间更贴反向溯源场景
- [ ] AC-14b: 历史 session title 批量回填 migration —— 启动时扫 `title IS NULL OR isDefaultTitle(title)` 批量排队 Haiku，带并发限流
- [ ] AC-14c: 前端 title fallback —— DB title 为空/默认/null 时 UI 显示 `新会话 {createdAtLabel}`，与 AC-08 失败回退格式一致

### Phase 4：标题栏三层 ID 补丁（0.5 天）
- [ ] AC-16: 右侧面板顶部 ROOM 徽章显示 `R-xxx`（与 F021 联动）
- [ ] AC-17: ChatHeader 显示 `R-xxx · {title}`，支持点击复制 ID
- [ ] AC-18: 消息元数据（调试态）可见 roomId

### Phase 5：验收
- [ ] AC-19: 桂芬视觉验收通过
- [ ] AC-20: 范德彪 code review 通过（Haiku 调用有超时、migration 幂等）
- [ ] AC-21: 小孙用"R-042"搜到历史房间 → OK

## Dependencies

- 依赖 Anthropic SDK（已有，F012 中的 claude-runtime）
- 依赖 session 持久化层（drizzle / SQLite，F011 已完成）
- 与 F021 联动（右侧面板顶部徽章共用 ROOM ID）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 自动命名时机 | 创建时 / 首 user 后 / 首 user+assistant 后 | **首 user + 首 assistant 后等 2-3 秒** | 产品拍板：换命名质量 |
| ROOM 编号策略 | 按 projectTag 分号 / 全局递增 | **全局递增 R-001, R-002...** | 产品拍板：像 GitHub Issue，简单易记跨项目可引用 |
| 命名用什么模型 | Haiku / Sonnet | **Haiku** | 命名是轻量总结任务，Haiku 成本低速度快 |
| 命名失败处理 | 报错阻塞 / 回退默认 | **回退到日期格式** | 命名是锦上添花，不阻塞主流程 |
| 历史 session 处理 | 不动 / 批量命名 / 按需命名 | **migration 先分 ID，title 按需触发 Haiku** | ID 必须立即全量回填，title 可以懒加载 |
| Title 长度上限 | 20 字 / 10 字 | **≤ 10 字**（2026-04-20 产品下调） | 20 字在 sidebar 条目里太长，左侧栏窄，短标题更清爽 |
| Agent 过滤 pills | 保留 / 删除 | **删除**（2026-04-20 产品下调） | worktree 预览验收后产品判定"用处不大"，Agent 头像已在条目显示，不需额外过滤入口 |
| Sidebar 分组维度 | projectTag / 时间 / 并存 | **时间分组替换 projectTag**（2026-04-20 产品下调） | projectTag 多数落"未分组"不承载索引价值；时间分组（置顶/今日/本周/本月/更早）更贴反向溯源场景 |
| 历史 title 处理 | 不动 / 按需 / 批量 / 批量+fallback | **批量回填 + 前端 fallback**（2026-04-20 产品下调） | 之前"懒加载"定义模糊 → 沉默会话永久无标题；改为启动 migration 批量 Haiku + UI 在 null/default 时展示 `新会话 {createdAtLabel}` 兜底 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-18 | collaborative-thinking 讨论（黄仁勋主导方案）|
| 2026-04-18 | 产品决策：Haiku 触发时机 + 全局递增 ID |
| 2026-04-19 | Kickoff |
| 2026-04-19 | Phase 1 实施完成（AC-01~04 ✅，TDD 10 新测试覆盖）|
| 2026-04-20 | 产品决策：title 上限 20 → 10 字；Haiku 命名走 CLI 订阅（不引 SDK）|
| 2026-04-20 | Phase 2 实施完成（AC-05~10 ✅，6 个 TDD commits，33 新测试覆盖；isDefaultTitle / updateSessionGroupTitle / HaikuRunner / SessionTitler / SessionService hook / buildTitlePrompt）|
| 2026-04-20 | Phase 3 实施完成（AC-11~15 ✅，5 个 commit；backend 透传 roomId/participants/messageCount/createdAtLabel → SessionCard R-xxx 前缀 + 真实参与者头像 + 悬停详情 → 搜索 R-xxx 精确跳转 + 自动选中 → Agent pills 多选 AND 过滤）|
| 2026-04-20 | worktree 预览验收（小孙 L1 @ :3200）发现 3 项反馈 → Phase 3.5 开（AC-14 Dropped + AC-14a/b/c 新增；产品决策固化到 Design Decisions）|

## Links

- Discussion: ROOM-042（本轮讨论 · timeline 见 MEMORY room context）
- Design: `docs/left-sidebar-redesign-huang.png` · `docs/header-id-patch-huang.png`
- Related: F021（右侧面板重设计，并行推进）

## Evolution

- **Evolved from**: F005（运行时治理 UI · 侧边栏重做）· F006（UI/UX 深度重塑 · 会话隔离）
- **Blocks**: 无
- **Related**: F021（同期，并行；共享 ROOM ID 作为徽章）· F018（上下文续接 · ROOM ID 可作为冷存储 key）
