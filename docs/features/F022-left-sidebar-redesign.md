---
id: F022
title: 左侧 Sidebar 重设计 — 全局递增 ROOM ID + Haiku 自动命名 + 反向溯源
status: done
owner: 黄仁勋
created: 2026-04-19
completed: 2026-04-21
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
- [x] AC-14a: 时间分组替换 projectTag 分组（置顶 / 今日 / 本周 / 本月 / 更早）—— projectTag 多数落"未分组"不承载索引价值，时间更贴反向溯源场景
- [x] AC-14b: 历史 session title 批量回填 migration —— 启动时扫 `title IS NULL OR isDefaultTitle(title)` 批量排队 Haiku，带并发限流
- [x] AC-14c: 前端 title fallback —— DB title 为空/默认/null 时 UI 显示 `新会话 {createdAtLabel}`，与 AC-08 失败回退格式一致
- [x] AC-14d: 标题分类前缀 —— Haiku 按会话意图输出 `{F|B|D|Q}-{≤8字描述}`（F=feature, B=bug, D=discussion, Q=question）；判不准默认落 `D-`；不符规则的输出由 sanitize 兜底 `D-` 前缀；AC-08 失败回退同步改为 `D-新会话 YYYY-MM-DD`
- [x] AC-14e: 立项号规则 —— 当会话中明确出现 `F\d+` / `B\d+` 编号时，标题前缀使用带号形式 `F022-xxx` / `B026-xxx`（编号原样照抄）；**裸 `F-` / `B-` 无号视为未立项，sanitize 降级为 `D-`**（F/B 前缀 ⇔ 已立项的身份声明）；描述部分统一 ≤ 8 字，带号前缀不受 10 字硬上限约束
- [x] AC-14f: **HaikuRunner 子进程 stdin 关闭 + 超时 15s**（修复 AC-05/06 回归）—— `proc.stdin?.end()` 防 Windows `claude --print` stdin-EOF hang；`DEFAULT_TIMEOUT_MS: 5000 → 15000` 给本地冷启动 ~8.4s 留余量；没这一步 AC-14a~e 全部废题
- [x] AC-14g: 右键菜单「重命名」启用 —— 行内输入框 ≤ 40 字，Enter 提交 `PATCH /api/session-groups/:id { title }`；重命名成功后写 `title_locked_at = now()`，SessionTitler 看到 lock 跳过 Haiku 覆盖；列表项前显示 🔒 图标提示"手动命名"
- [x] AC-14h: 右键菜单「清除项目标签」独立入口 —— 当 `projectTag != null` 时可见，点击 `PATCH {projectTag: null}`，无二次确认（标签语义轻，后端已支持）
- [x] AC-14i: 右键菜单「归档」启用 —— DB 加 `archived_at` 字段，归档项从主列表移除；侧栏底部新增「归档列表」视图展示 `archived_at != null` 或 `deleted_at != null` 的条目；归档列表每条带小标签（"归档中" / "已删除"）区分状态；点击可恢复（清 `archived_at` / `deleted_at`）
- [x] AC-14j: 右键菜单「删除」启用（软删）—— `deleted_at` 字段，二次确认弹框，确认后软删并进归档列表的"已删除"区；**铁律 1：不提供物理删除/彻底清除按钮**，只支持恢复

### Phase 4：标题栏三层 ID 补丁（**Dropped 2026-04-21 — 迁移 F021**）
- [~] AC-16: ~~右侧面板顶部 ROOM 徽章显示 `R-xxx`（与 F021 联动）~~ **迁 F021**
- [~] AC-17: ~~ChatHeader 显示 `R-xxx · {title}`，支持点击复制 ID~~ **迁 F021**
- [~] AC-18: ~~消息元数据（调试态）可见 roomId~~ **迁 F021**

> 2026-04-21 小孙决策：三层 ID 徽章本质属于右侧面板/ChatHeader 重设计范畴，F021 正在做同模块，合并处理避免重复改动。F022 只保留侧栏重塑（Phase 1~3.5）。

### Phase 5：验收
- [ ] AC-19: 桂芬视觉验收通过
- [x] AC-20: 范德彪 code review 通过（Haiku 调用有超时、migration 幂等；4 轮修复后 3rd round 放行 `b5e4474`）
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
| 标题分类前缀 | 自由文本 / `{F\|B\|D\|Q}-` 前缀 | **`{F\|B\|D\|Q}-{描述}`，判不准落 D-**（2026-04-20 产品拍板） | 小孙需要一眼看出会话性质（做 feature / 修 bug / 讨论 / 问答）；分类不准落 `D-` 偏宽容，错分概率低；Haiku 下一轮 debounce 会纠正 |
| F/B 立项号 | 不带号 / 带号 / 立项必带 | **立项必带号（`F022-xxx` / `B026-xxx`），无号 F/B 降级 D-**（2026-04-20 产品下调） | 小孙："F B 如果立项了要加上 F012 B026 这样 是多少就是多少"；F/B 前缀本身就蕴含"已立项"身份声明，没编号就不配叫 F/B，统一归到讨论 D-。消除"伪 feature 讨论"与"真立项"的混淆 |
| 会话删除语义 | 硬删 / 软删+回收站 / 软删+归档列表 | **软删（`deleted_at`）**（2026-04-20 产品拍板） | 铁律 1：数据神圣不可删；软删进归档列表可恢复，永不物理删除 |
| 归档 vs 删除视图 | 归档列表 + 回收站双视图 / 单归档列表双状态 | **单归档列表，条目带"归档中 / 已删除"状态小标签**（2026-04-20 产品下调） | 小孙："就来一个归档列表就行了"；减少视图复杂度，用状态标签区分语义；不提供"彻底清除"按钮（铁律 1 兜底） |
| 手动重命名后 Haiku 覆盖 | 允许覆盖 / `title_locked_at` 锁字段 | **加 `title_locked_at` 锁字段，SessionTitler 看锁跳过**（2026-04-20 产品拍板） | 否则"重命名"按钮做出来 2 秒就被 Haiku 盖掉形同废物；列表项 🔒 小图标提示"手动命名" |

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
| 2026-04-21 | Phase 3.5 实施完成（AC-14a~j ✅）：时间分组 + 历史回填 migration + title fallback + F/B/D/Q 分类前缀 + 立项号识别 + HaikuRunner stdin/超时修复 + 右键菜单四件套（重命名/清除项目标签/归档/软删）+ 归档列表视图 · typecheck ✅ · 928/928 tests ✅ · 小孙 :3200 分桶 + 右键菜单实机验收通过 |
| 2026-04-21 | 小孙决策：Phase 4（AC-16/17/18 标题栏三层 ID 徽章）Dropped，迁移至 F021 右侧面板重设计合并处理 |
| 2026-04-21 | 范德彪 code review 4 轮迭代（`840a474` → `fee622c` → `1624f7b` → `b5e4474`），3rd round 放行 ✅；P2（前端状态机无自动化测试覆盖）小孙决策路径 B — rebase F022 worktree 到 origin/dev 带入 F025 vitest infra，本轮闭合：抽 `dispatchArchiveStateChanged` 纯 helper + 7 个回归用例（archive/delete/restore/no-match + store 身份守卫） |
| 2026-04-21 | 范德彪 4th round：P2（sidebar.tsx archiveStateVersion useEffect + reload 效果裸奔）→ `5124443`：抽 `useArchiveStateReloader` hook + 4 个回归用例覆盖"远端归档后 sidebar 刷新"契约 |
| 2026-04-21 | 范德彪 5th round 放行 ✅（本地 squash merge · commit `d6f29eb`）：typecheck ✅ · 后端 943/943 ✅ · 前端 vitest 14/14 ✅ · rebase onto origin/dev(162ece8) · Residual risk: 未跑浏览器双标签页实机(前端 vitest 已覆盖核心契约) |

## Links

- Discussion: ROOM-042（本轮讨论 · timeline 见 MEMORY room context）
- Design: `docs/left-sidebar-redesign-huang.png` · `docs/header-id-patch-huang.png`
- Related: F021（右侧面板重设计，并行推进）

## Evolution

- **Evolved from**: F005（运行时治理 UI · 侧边栏重做）· F006（UI/UX 深度重塑 · 会话隔离）
- **Blocks**: 无
- **Related**: F021（同期，并行；共享 ROOM ID 作为徽章）· F018（上下文续接 · ROOM ID 可作为冷存储 key）
