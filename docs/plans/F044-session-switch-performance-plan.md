# Session Switch Performance Implementation Plan

**Feature:** F044 — `docs/features/F044-session-switch-performance.md`
**Goal:** 会话卡点击立即得到稳定反馈，并把长会话首载从全量历史收敛为最新 100 条的可续页窗口，同时不破坏 F031 的 active/WS 可靠性语义。
**Acceptance Criteria:**
- AC1：独立 `pendingGroupId` 同步写入；真实 active 只提交最新成功请求；当前会话重选零请求；旧响应不能覆盖新选择。
- AC2：手机会话卡点击立即关抽屉；pending 卡和时间线骨架可见；失败保留原 active 并显示恢复提示。
- AC3：UI active-group 路由默认最新 100 条，返回稳定 `createdAt + rowid` 游标；内部全量语义不变。
- AC4：顶部按需加载更早 100 条，去重、保序并保留阅读锚点，完整历史仍可访问。
- AC5：minimap DOM ≤120；只摘要保留 marker；统计单次遍历且不拼接全文临时字符串。
- AC6：单元/路由/组件/E2E 覆盖分页、竞态、手机点击、历史加载和 marker 上限。
- AC7：F031 watermark/delta/catch-up、归档、未读、decision/runtime-config 后续拉取不回归。
**Architecture:** 后端新增 UI 专用时间线页查询，以 SQLite `created_at DESC, rowid DESC` 组成稳定内部游标，并在 HTTP 层编码为不透明 base64url；原 `getActiveGroup()` 保持全量语义，新增 `getActiveGroupPage()` 只给切换路由使用。前端用独立 pending 状态和 AbortController/代际号管理切换，成功后一次性提交 active snapshot；时间线页元数据驱动顶部“加载更早消息”。
**Tech Stack:** TypeScript、Fastify、Drizzle/SQLite、Zustand、React 19、TanStack Virtual、Vitest、node:test、Playwright。

---

## Straight-Line Check

- **Finish line B**：点击立即反馈；最大房间首载最多 100 条；历史可按游标完整加载；长会话不会创建超过 120 个 minimap button。我们不重做 Sidebar IA、不改实时内部全量 snapshot 合同、不引 IndexedDB 缓存。
- **Terminal schema**：

```ts
export type TimelinePageMeta = {
  hasMore: boolean
  nextCursor: string | null
  limit: number
}

type ActiveGroupPageResponse = {
  activeGroup: ActiveGroupView
  timelinePage: TimelinePageMeta
  wsWatermark?: WsWatermark
}

type ThreadStoreTimelinePage = TimelinePageMeta & {
  loading: boolean
  error: string | null
}
```

- 每个任务产物都直接进入终态：仓储游标供两个 HTTP 路由复用；pending 状态直接服务 UI；分页元数据直接服务历史加载；marker cap 是最终性能护栏。

### Task 1: SQLite 稳定时间线页

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.ts`
- Test: `packages/api/src/db/repositories/session-repository-drizzle.test.ts`

**Step 1: Write the failing repository tests**

新增 205 条跨三个 thread 的消息，其中分页边界有多条相同 `createdAt`：

```ts
const first = repo.listGroupMessagesPage(group.id, { limit: 100 })
assert.equal(first.messages.length, 100)
assert.equal(first.hasMore, true)

const second = repo.listGroupMessagesPage(group.id, {
  limit: 100,
  before: first.nextCursor!,
})
assert.equal(new Set([...first.messages, ...second.messages].map((m) => m.id)).size, 200)
assert.deepEqual(
  [...second.messages, ...first.messages].map((m) => m.id),
  repo.listMessagesForAssertion(group.id).slice(-200).map((m) => m.id),
)
```

另测非法 limit、跨 group 隔离和最后一页 `hasMore=false/nextCursor=null`。

**Step 2: Run RED**

Run:

```powershell
pnpm exec tsx --test packages/api/src/db/repositories/session-repository-drizzle.test.ts
```

Expected: FAIL，`listGroupMessagesPage is not a function`。

**Step 3: Implement the minimum repository query**

```ts
export type GroupMessageCursor = { createdAt: string; rowid: number }

listGroupMessagesPage(
  sessionGroupId: string,
  options: { limit: number; before?: GroupMessageCursor },
): {
  messages: Array<{ message: MessageRecord; cursor: GroupMessageCursor }>
  hasMore: boolean
  nextCursor: GroupMessageCursor | null
} {
  // INNER JOIN threads 限 group；LEFT JOIN a2a_calls 保持协议字段；
  // WHERE (created_at < ?) OR (created_at = ? AND rowid < ?)
  // ORDER BY created_at DESC, messages.rowid DESC LIMIT limit + 1
}
```

返回给 service 前把选中页反转成时间升序；多取一条只用于 `hasMore`，不能进入 messages。

**Step 4: Run GREEN**

同 Step 2，Expected: 新旧仓储测试全部 PASS。

**Step 5: Commit**

```powershell
git add packages/api/src/db/repositories/session-repository-drizzle.ts packages/api/src/db/repositories/session-repository-drizzle.test.ts
git commit -m "feat(F044): add stable group timeline cursor [范德彪/GPT-5 🐾]"
```

### Task 2: UI 专用 active-group 窗口路由

**Files:**
- Modify: `packages/shared/src/realtime.ts`
- Modify: `packages/api/src/services/session-service.ts`
- Modify: `packages/api/src/routes/threads.ts`
- Test: `packages/api/src/services/session-service.test.ts`
- Test: `packages/api/src/routes/threads.test.ts`
- Test: `packages/api/src/routes/threads.watermark.test.ts`

**Step 1: Write failing service/route tests**

```ts
test("F044 active page returns newest 100 while internal snapshot stays full", () => {
  const full = service.getActiveGroup(groupId, new Set())
  const page = service.getActiveGroupPage(groupId, new Set(), undefined, { limit: 100 })
  assert.equal(full.timeline.length, 205)
  assert.equal(page.activeGroup.timeline.length, 100)
  assert.equal(page.timelinePage.hasMore, true)
})
```

路由测试锁定：

```ts
assert.equal(body.activeGroup.timeline.length, 100)
assert.equal(body.timelinePage.limit, 100)
assert.equal(typeof body.timelinePage.nextCursor, "string")
assert.deepEqual(body.wsWatermark, expectedWatermark)
```

第二页 `GET /api/session-groups/:groupId/timeline?before=<opaque>` 返回更早消息；坏 cursor → 400，不得 500。

**Step 2: Run RED**

```powershell
pnpm exec tsx --test packages/api/src/services/session-service.test.ts packages/api/src/routes/threads.test.ts packages/api/src/routes/threads.watermark.test.ts
```

Expected: FAIL，缺 `getActiveGroupPage` / `timelinePage` / timeline route。

**Step 3: Implement final HTTP contract**

```ts
export type TimelinePageMeta = {
  hasMore: boolean
  nextCursor: string | null
  limit: number
}
```

`SessionService.getActiveGroupPage()` 只读取当前页 + 每 thread 最近 10 条用于 provider preview/sealed；`getActiveGroup()` 原实现保留全量。游标 JSON `{v:1,createdAt,rowid}` 经 base64url 编解码并做严格 schema 校验。初始路由仍保持 F031 的 read-before-build watermark 顺序。

**Step 4: Run GREEN + F031 regressions**

同 Step 2，Expected: PASS。

**Step 5: Commit**

```powershell
git add packages/shared/src/realtime.ts packages/api/src/services/session-service.ts packages/api/src/routes/threads.ts packages/api/src/services/session-service.test.ts packages/api/src/routes/threads.test.ts packages/api/src/routes/threads.watermark.test.ts
git commit -m "feat(F044): window session switch snapshots [范德彪/GPT-5 🐾]"
```

### Task 3: Zustand 即时切换与竞态保护

**Files:**
- Modify: `components/stores/thread-store.ts`
- Test: `components/stores/thread-store.select-group.test.ts`
- Test: `components/stores/thread-store.test.ts`

**Step 1: Write deferred-fetch RED tests**

```ts
const first = deferred<Response>()
const second = deferred<Response>()
fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

const p1 = store.selectSessionGroup("g1")
expect(store.pendingGroupId).toBe("g1")
const p2 = store.selectSessionGroup("g2")
expect(store.pendingGroupId).toBe("g2")

second.resolve(snapshot("g2"))
await p2
first.resolve(snapshot("g1"))
await p1
expect(store.activeGroupId).toBe("g2")
```

分别锁定当前会话重选 `fetch` 0 次、失败保留旧 active、成功一次性更新 active/timeline/providers、分页元数据写入、AbortSignal 被触发。

**Step 2: Run RED**

```powershell
pnpm exec vitest run components/stores/thread-store.select-group.test.ts components/stores/thread-store.test.ts
```

Expected: FAIL，缺 pending/page state，旧响应能覆盖新选择。

**Step 3: Implement the minimum switch coordinator**

```ts
let switchGeneration = 0
let switchController: AbortController | null = null

selectSessionGroup: async (groupId) => {
  if (groupId === get().activeGroupId && !get().pendingGroupId) return
  const generation = ++switchGeneration
  switchController?.abort()
  const controller = new AbortController()
  switchController = controller
  set({ pendingGroupId: groupId, switchError: null })
  // subscribe-before-fetch 不动
  // 只有 generation === switchGeneration 才一次性提交 active snapshot
}
```

`activeGroupId` 不得在 fetch 前写。真实失败写 `switchError`，Abort/stale 静默返回。

**Step 4: Implement/load older with RED→GREEN**

新增测试后实现：

```ts
loadOlderTimeline: async (): Promise<number> => {
  // 用 activeGroupId + nextCursor 拉页；响应回来时 group 已切换则丢弃；
  // prepend + id 去重 + createdAt 稳定排序；返回新增条数供 UI 恢复锚点。
}
```

**Step 5: Run GREEN + F031 tests**

```powershell
pnpm exec vitest run components/stores/thread-store.select-group.test.ts components/stores/thread-store.test.ts components/ws/stream-monitor.test.ts components/ws/f031-integration.test.ts
```

Expected: PASS。

**Step 6: Commit**

```powershell
git add components/stores/thread-store.ts components/stores/thread-store.select-group.test.ts components/stores/thread-store.test.ts
git commit -m "feat(F044): make session switching immediate and race-safe [范德彪/GPT-5 🐾]"
```

### Task 4: Preserve 模式 UI 状态与历史入口

**Files:**
- Modify: `components/chat/session-sidebar.tsx`
- Modify: `components/chat/timeline-panel.tsx`
- Test: `components/chat/session-sidebar.test.tsx`
- Test: `components/chat/timeline-panel.test.tsx`

**Step 1: Write RED component tests**

- pending card 具有 `aria-busy=true`、`data-session-pending=true`，并立即使用选中表面。
- 时间线 pending 时出现 `data-testid="session-switch-pending"` + `SkeletonLines`。
- `hasMore=true` 时顶部显示“加载更早消息”；点击后调用 store action，新增 N 条后 `scrollToIndex(N)`。
- `switchError` 显示 inline 恢复提示，切换成功后消失。

**Step 2: Run RED**

```powershell
pnpm exec vitest run components/chat/session-sidebar.test.tsx components/chat/timeline-panel.test.tsx
```

Expected: FAIL，当前组件没有这些状态。

**Step 3: Implement DESIGN.md-compliant states**

- 手机卡点击先同步 `toggleSidebar()`，再启动/等待 `selectGroup()`；桌面不关 Sidebar。
- SessionCard 只用现有 accent/surface token；删除 `transition` 全属性，改 `transition-transform active:scale-[0.99] motion-reduce:transform-none`。
- pending 使用 lucide `LoaderCircle`，`animate-spin motion-reduce:animate-none`；时间线用现有 `SkeletonLines`。
- 错误采用 red 状态族 + “重试”路径，不新增颜色/字号/圆角任意值。

**Step 4: Run GREEN**

同 Step 2，Expected: PASS。

**Step 5: Design audit**

```powershell
rg -n "#[0-9a-fA-F]{6}|rgba\(|text-\[[0-9.]+px\]|rounded-\[[0-9]" components/chat/session-sidebar.tsx components/chat/timeline-panel.tsx
rg -n "transition($|\s)" components/chat/session-sidebar.tsx components/chat/timeline-panel.tsx
```

Expected: 新增违规 0；交互动效仅 transform/opacity。

**Step 6: Commit**

```powershell
git add components/chat/session-sidebar.tsx components/chat/timeline-panel.tsx components/chat/session-sidebar.test.tsx components/chat/timeline-panel.test.tsx
git commit -m "feat(F044): show immediate session switch feedback [范德彪/GPT-5 🐾]"
```

### Task 5: Minimap 与状态统计减压

**Files:**
- Modify: `components/chat/timeline-minimap.tsx`
- Modify: `components/chat/timeline-minimap.test.tsx`
- Create: `components/chat/timeline-stats.ts`
- Create: `components/chat/timeline-stats.test.ts`
- Modify: `components/chat/status-panel.tsx`

**Step 1: Write RED performance-contract tests**

```ts
const summarize = vi.fn((s: string) => s)
const markers = buildMinimapMarkers(make1000Anchors(), summarize)
expect(markers.length).toBeLessThanOrEqual(120)
expect(summarize).toHaveBeenCalledTimes(markers.filter((m) => m.kind === "user").length)
expect(markers[0].index).toBe(0)
expect(markers.at(-1)?.index).toBe(999)
```

统计测试锁定 messages/evidence/followUp 结果与旧实现一致，并用带 getter 的 content/thinking 记录每条最多读取一次。

**Step 2: Run RED**

```powershell
pnpm exec vitest run components/chat/timeline-minimap.test.tsx components/chat/timeline-stats.test.ts
```

Expected: FAIL，1000 anchors 仍生成 1000 markers / stats helper 不存在。

**Step 3: Implement deterministic downsampling + one-pass stats**

- `MAX_MINIMAP_MARKERS = 120`。
- 先收集 raw anchor，不调用 summarize；seal 优先保留，剩余 user 预算按序位均匀抽样；最后按原 index 排序并仅摘要入选 user。
- `computeTimelineStats()` 单循环；evidence 正则分别测试 content 与 thinking，不构造拼接字符串。

**Step 4: Run GREEN**

同 Step 2，Expected: PASS。

**Step 5: Commit**

```powershell
git add components/chat/timeline-minimap.tsx components/chat/timeline-minimap.test.tsx components/chat/timeline-stats.ts components/chat/timeline-stats.test.ts components/chat/status-panel.tsx
git commit -m "perf(F044): cap long-session render work [范德彪/GPT-5 🐾]"
```

### Task 6: 真浏览器 E2E 与收口

**Files:**
- Modify: `tests/e2e/session-groups.spec.ts`
- Modify: `docs/features/F044-session-switch-performance.md`

**Step 1: Write the failing Playwright tests**

用临时库 API 创建两个会话；对目标 active-group GET 设置可控 gate（最终仍 `route.continue()` 访问真 API）：

```ts
await target.click()
await expect(target).toHaveAttribute("aria-busy", "true")
await expect(page.getByTestId("session-switch-pending")).toBeVisible()
releaseResponse()
await expect(target).toHaveAttribute("aria-current", "true")
```

手机 viewport 测试在 release 前断言“关闭会话列表”遮罩已隐藏。分页用临时 API fixture 真实插入 >100 条非 @ 消息，断言 initial 100、点击加载更早后旧 id 可见、API 独立查询总数不变。

**Step 2: Verify E2E RED**

```powershell
$env:E2E_WEB_PORT=4004; $env:E2E_API_PORT=9004; pnpm exec playwright test tests/e2e/session-groups.spec.ts
```

Expected: 新用例 FAIL 于 pending/mobile/pagination 断言。

**Step 3: Run E2E GREEN and falsification check**

同 Step 2，Expected: 全部 PASS。然后临时把 SessionCard 的 `onClick` 置空，确认新用例 FAIL；恢复产品代码并复跑 PASS（不提交验红破坏）。

**Step 4: Full verification**

```powershell
pnpm typecheck
pnpm test
$env:E2E_WEB_PORT=4004; $env:E2E_API_PORT=9004; pnpm test:e2e
pnpm build
```

Expected: 全绿。浏览器截图与 trace 落 `.agents/acceptance/F044/`。

**Step 5: Update feature progress and commit**

把实际证据、payload 前后对比、浏览器截图路径写回 F044 Timeline；AC 只按真实证据勾选。

```powershell
git add tests/e2e/session-groups.spec.ts docs/features/F044-session-switch-performance.md
git commit -m "test(F044): lock session switch performance journey [范德彪/GPT-5 🐾]"
```

## Post-implementation Gates

1. `quality-gate`：愿景/AC/验证命令证据。
2. `acceptance-guardian`：零上下文 agent 复跑小孙原话对照表与浏览器 AC。
3. `requesting-review`：把 spec/diff/test/evidence 五件套交 Claude（黄仁勋）独立 review。
4. `receiving-review`：逐项 VERIFY，Red→Green 修复并请同 reviewer 复审。
5. `merge-gate`：PR、squash merge、Phase 文档同步、停止 preview、清 worktree。
