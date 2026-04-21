# F022 Phase 3 Implementation Plan — Sidebar UI 重塑

**Feature:** F022 — `docs/features/F022-left-sidebar-redesign.md`
**Goal:** 把左 sidebar 条目从"标题驱动"改造为"ROOM ID 驱动"——`R-xxx · {title}` + 参与 agent 头像堆叠 + `R-042` 精确跳转 + agent 过滤 + 悬停详情。
**Phase 1/2 Status:** ✅ AC-01~10（ROOM ID + Haiku 自动命名）
**Branch/Worktree:** `multi-agent-f022-phase1` (branch `feat/f022-phase1`)

## Acceptance Criteria (Phase 3)

- [ ] **AC-11** 条目显示 `R-xxx · {语义 title}`（ID 在前，title 紧跟；`R-xxx` 等宽字体）
- [ ] **AC-12** 条目下方显示 agent 头像堆叠（真正发过消息的 agents，不是预创建的 thread）
- [ ] **AC-13** 搜索框输入 `R-042` 直跳该房间（大小写不敏感；支持 `r42` / `R42` / `R-042` 三种输入）
- [ ] **AC-14** 搜索支持按 agent 过滤（头像 pills，点击 toggle 过滤）
- [ ] **AC-15** 条目悬停显示完整信息（创建时间 / 最后活动 / 消息数），原生 `title` 属性即可

## Architecture

- **数据层**：`SessionGroupSummary` 新增 `roomId: string | null` + `participants: Provider[]` + `createdAtLabel: string` + `messageCount: number`；来源于已有的 `SessionRepository.listSessionGroups()`（drizzle 版），**参与 agent = 该 group 下有至少 1 条消息的 provider**（过滤掉只有预创建 thread 的 provider）。
- **Store 层**：`SessionListItem` 镜像新字段；`normalizeSessionGroups` 透传。
- **组件层**：`SessionCard` 显示 `R-xxx ·` 前缀 + 下方头像堆叠替换现有"最后消息 provider 头像"；`SessionSidebar` 新增 `AgentFilter` pills + ROOM ID 跳转逻辑。
- **不做**：
  - 不改 `SessionService.listSessionGroups()` 的数据库查询结构（已在 Phase 1 拉到 roomId），只加 participants / messageCount 字段。
  - 不做后端分页 / 虚拟滚动（YAGNI，当前列表 <200）。
  - 不做 ChatHeader / 右侧 ROOM 徽章（那是 Phase 4，AC-16~18）。
  - 不做桂芬视觉 / 范德彪 review / 小孙搜索验收（Phase 5）。

## Tech Stack

- 前端：React 18 + Zustand + Tailwind（已有）
- 后端：drizzle-orm SQL `GROUP BY` + `COUNT`（已有）
- 测试：`node:test` + `node:assert/strict`（后端）；前端改动无新单测，靠 Phase 5 视觉验收
- 复用：已有的 `ProviderAvatar`（`components/chat/provider-avatar.tsx`）

---

### Terminal Schema (终态接口定义)

```typescript
// packages/shared/src/realtime.ts — 新增 4 字段
export type SessionGroupSummary = {
  id: string
  roomId: string | null          // NEW — Phase 1 已写库，Phase 3 透传到前端
  title: string
  updatedAtLabel: string         // 既有：相对时间（"3 小时前"）
  createdAtLabel: string         // NEW — 本地化绝对时间（"2026-04-18 14:30"）
  projectTag?: string
  participants: Provider[]       // NEW — 真正发过消息的 provider，按 provider 字母序
  messageCount: number           // NEW — 该 group 下 messages 总数
  previews: Array<{ provider: Provider; alias: string; text: string }>
}

// components/stores/thread-store.ts — SessionListItem 镜像新字段
type SessionListItem = {
  id: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  projectTag?: string
  pinned?: boolean
  unreadCount?: number
  participants: Provider[]
  messageCount: number
  previews: Array<{ provider: Provider; alias: string; text: string }>
}
```

---

### Task 1: Shared type — `SessionGroupSummary` 加 4 字段

**Files:**
- Modify: `packages/shared/src/realtime.ts:112-122`

**Step 1 — Edit:**

```typescript
export type SessionGroupSummary = {
  id: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  projectTag?: string
  participants: Provider[]
  messageCount: number
  previews: Array<{
    provider: Provider
    alias: string
    text: string
  }>
}
```

**Step 2 — 验证 TS 编译：**
`cd C:/Users/-/Desktop/multi-agent-f022-phase1 && pnpm --filter @multi-agent/shared build`
**Expected：** PASS。消费侧（api / web）会出现 TS 红线（缺字段），进入 Task 2 修复。

**Step 3 — Commit（留红测试状态）：**
```bash
git add packages/shared/src/realtime.ts
git commit -m "feat(F022-P3): SessionGroupSummary 新增 roomId + participants + createdAtLabel + messageCount"
```

---

### Task 2: Repo — `listSessionGroups` 返回 participants + messageCount

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.ts:86-152`（listSessionGroups）
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.test.ts`（新增 2 测试）

**Step 1 — Failing tests（追加到现有 test 文件末尾）：**

```typescript
test("F022 AC-12: listSessionGroups participants 只含真正发过消息的 provider", async () => {
  const repo = await makeRepo()
  const groupId = repo.createSessionGroup()
  repo.ensureDefaultThreads(groupId, { claude: null, codex: null, gemini: null })
  const threads = repo.listThreadsByGroup(groupId)
  const claudeThread = threads.find(t => t.provider === "claude")!
  const codexThread = threads.find(t => t.provider === "codex")!
  repo.appendMessage({ threadId: claudeThread.id, role: "user", content: "hi", messageType: "final" })
  repo.appendMessage({ threadId: codexThread.id, role: "assistant", content: "ok", messageType: "final" })
  // gemini thread 存在但无消息
  const list = repo.listSessionGroups() as Array<{ participants?: Provider[]; messageCount?: number }>
  const row = list.find(g => (g as any).id === groupId)!
  assert.deepEqual([...row.participants!].sort(), ["claude", "codex"])
  assert.equal(row.messageCount, 2)
})

test("F022 AC-15: listSessionGroups 返回 messageCount=0 for empty group", async () => {
  const repo = await makeRepo()
  const groupId = repo.createSessionGroup()
  repo.ensureDefaultThreads(groupId, { claude: null, codex: null, gemini: null })
  const list = repo.listSessionGroups() as Array<{ messageCount?: number; participants?: Provider[] }>
  const row = list.find(g => (g as any).id === groupId)!
  assert.equal(row.messageCount, 0)
  assert.deepEqual(row.participants, [])
})
```

**Step 2 — Run:**
`pnpm --filter @multi-agent/api exec tsx --test packages/api/src/db/repositories/session-repository-drizzle.test.ts`
**Expected:** FAIL（`participants` / `messageCount` 未定义）。

**Step 3 — Implementation（替换 `listSessionGroups`）：**

核心改动：原有 SELECT 已拿到每条 `(group, provider, lastMessage)` 行。新增一个独立 subquery 统计 per-group-per-provider 的 messageCount，再按 group 聚合。

```typescript
listSessionGroups(limit = 200) {
  const groupIds = this.db
    .select({ id: sessionGroups.id })
    .from(sessionGroups)
    .orderBy(desc(sessionGroups.updatedAt))
    .limit(limit)
    .all()
    .map(r => r.id)
  if (groupIds.length === 0) return []

  // 原有 rows（group × thread × lastMessage）
  const rows = this.db
    .select({
      id: sessionGroups.id,
      roomId: sessionGroups.roomId,
      title: sessionGroups.title,
      projectTag: sessionGroups.projectTag,
      createdAt: sessionGroups.createdAt,
      updatedAt: sessionGroups.updatedAt,
      provider: threads.provider,
      alias: threads.alias,
      lastMessage: sql<string | null>`(SELECT content FROM messages WHERE thread_id = ${threads.id} ORDER BY created_at DESC LIMIT 1)`,
      msgCount: sql<number>`(SELECT COUNT(*) FROM messages WHERE thread_id = ${threads.id})`,
    })
    .from(sessionGroups)
    .leftJoin(threads, eq(threads.sessionGroupId, sessionGroups.id))
    .where(sql`${sessionGroups.id} IN (${sql.join(groupIds.map(id => sql`${id}`), sql`, `)})`)
    .orderBy(desc(sessionGroups.updatedAt), asc(threads.provider))
    .all()

  const groupMap = new Map<string, {
    id: string; roomId: string | null; title: string; projectTag: string | null
    createdAt: string; updatedAt: string
    previews: Array<{ provider: Provider; alias: string; text: string }>
    participants: Provider[]
    messageCount: number
  }>()

  for (const row of rows) {
    let group = groupMap.get(row.id)
    if (!group) {
      group = {
        id: row.id,
        roomId: row.roomId ?? null,
        title: row.title,
        projectTag: row.projectTag ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        previews: [],
        participants: [],
        messageCount: 0,
      }
      groupMap.set(row.id, group)
    }
    if (row.provider) {
      group.previews.push({
        provider: row.provider as Provider,
        alias: row.alias!,
        text: (row.lastMessage ?? "").slice(0, 80),
      })
      const count = Number(row.msgCount ?? 0)
      group.messageCount += count
      if (count > 0 && !group.participants.includes(row.provider as Provider)) {
        group.participants.push(row.provider as Provider)
      }
    }
  }

  // 稳定顺序：participants 按 provider 字母序
  for (const g of groupMap.values()) g.participants.sort()
  return Array.from(groupMap.values())
}
```

**Step 4 — Run:** PASS（新增 2 测 + 既有 AC-02 roomId 测试继续绿）。
同时跑 `pnpm --filter @multi-agent/api test` 全绿（确认无回归）。

**Step 5 — Commit:**
```bash
git add packages/api/src/db/repositories/session-repository-drizzle.ts packages/api/src/db/repositories/session-repository-drizzle.test.ts
git commit -m "feat(F022-P3): listSessionGroups 新增 participants + messageCount"
```

---

### Task 3: Service — `SessionService.listSessionGroups` 透传新字段

**Files:**
- Modify: `packages/api/src/services/session-service.ts:64-72`
- Modify: `packages/api/src/services/session-service.test.ts`（既有 `listSessionGroups: () => []` mock 无需改，但补一条新测）

**Step 1 — Failing test:**

```typescript
test("F022 AC-11/12: SessionService.listSessionGroups 透传 roomId + participants + messageCount + createdAtLabel", () => {
  const repo = {
    listSessionGroups: () => [{
      id: "g1", roomId: "R-042", title: "学习 TDD",
      projectTag: null, createdAt: "2026-04-18T06:30:00.000Z", updatedAt: "2026-04-20T06:00:00.000Z",
      previews: [], participants: ["claude", "codex"], messageCount: 12,
    }],
    // ...其他 repo 方法 mock
  }
  const service = new SessionService(repo as never, [])
  const [row] = service.listSessionGroups()
  assert.equal(row.roomId, "R-042")
  assert.deepEqual(row.participants, ["claude", "codex"])
  assert.equal(row.messageCount, 12)
  assert.match(row.createdAtLabel, /2026/)       // 包含年份即可，具体格式 locale 依赖
  assert.match(row.updatedAtLabel, /2026/)
})
```

**Step 2 — Run:** FAIL（字段未透传）。

**Step 3 — Implementation:**

```typescript
listSessionGroups(): SessionGroupSummary[] {
  return this.repository.listSessionGroups().map((group) => ({
    id: group.id,
    roomId: group.roomId ?? null,
    title: group.title,
    updatedAtLabel: new Date(group.updatedAt).toLocaleString("zh-CN"),
    createdAtLabel: new Date(group.createdAt).toLocaleString("zh-CN"),
    projectTag: group.projectTag ?? undefined,
    participants: group.participants ?? [],
    messageCount: group.messageCount ?? 0,
    previews: group.previews,
  }))
}
```

**Step 4 — Run:** PASS + 全量 api 测试绿。

**Step 5 — Commit:**
```bash
git add packages/api/src/services/session-service.ts packages/api/src/services/session-service.test.ts
git commit -m "feat(F022-P3): SessionService 透传 roomId/participants/messageCount 到前端"
```

---

### Task 4: Store — `SessionListItem` 镜像新字段

**Files:**
- Modify: `components/stores/thread-store.ts:40-48`（类型）
- Modify: `components/stores/thread-store.ts:119-127`（`normalizeSessionGroups`）

**Step 1 — Edit（类型）：**

```typescript
type SessionListItem = {
  id: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  projectTag?: string
  pinned?: boolean
  unreadCount?: number
  participants: Provider[]
  messageCount: number
  previews: Array<{ provider: Provider; alias: string; text: string }>
}
```

**Step 2 — Edit（`normalizeSessionGroups`）：**

```typescript
function normalizeSessionGroups(groups: SessionGroupSummary[]): SessionListItem[] {
  return groups.map((group) => ({
    id: group.id,
    roomId: group.roomId,
    title: group.title,
    updatedAtLabel: group.updatedAtLabel,
    createdAtLabel: group.createdAtLabel,
    projectTag: group.projectTag,
    participants: group.participants,
    messageCount: group.messageCount,
    previews: group.previews,
  }))
}
```

**Step 3 — 验证 TS：** `pnpm next build --no-lint` 或 `pnpm tsc --noEmit`（走 web 包）。
**Expected:** PASS（`session-sidebar.tsx` 会有若干未用新字段的 TS warning，无 error）。

**Step 4 — Commit:**
```bash
git add components/stores/thread-store.ts
git commit -m "feat(F022-P3): thread-store SessionListItem 镜像 roomId/participants/messageCount"
```

---

### Task 5: SessionCard — `R-xxx · title` 前缀 + agent 头像堆叠 + 悬停详情

**Files:**
- Modify: `components/chat/session-sidebar.tsx`

**Step 1 — 改 `SessionCardProps`（增加字段）：**

```typescript
type SessionCardProps = {
  groupId: string
  roomId: string | null
  title: string
  updatedAtLabel: string
  createdAtLabel: string
  messageCount: number
  unreadCount: number
  participants: Provider[]           // NEW
  previews: Array<{ provider: Provider; alias: string; text: string }>
  active: boolean
  running: boolean
  isPinned: boolean
  onSelect: (groupId: string) => void
  onCtxMenu: (e: React.MouseEvent, groupId: string, isPinned: boolean) => void
}
```

**Step 2 — 在 `SessionCard` 顶行替换 title 渲染（AC-11）：**

```tsx
<div className="flex items-center gap-2 min-w-0">
  {running && (<span className="relative flex h-2 w-2 shrink-0">...</span>)}
  {roomId && (
    <span className="shrink-0 font-mono text-[11px] font-semibold text-amber-600 tracking-tight">
      {roomId}
    </span>
  )}
  <h3 className="truncate text-sm font-medium text-slate-800">
    {roomId ? <span className="mx-1 text-slate-300">·</span> : null}
    {title}
  </h3>
</div>
```

**Step 3 — 替换底部 avatar 渲染（AC-12，原来用 `previews`，现用 `participants`）：**

```tsx
<div className="mt-1.5 flex items-center gap-2">
  <div className="flex -space-x-1.5">
    {participants.length === 0 ? (
      <span className="text-[10px] text-slate-400">尚无 agent 参与</span>
    ) : participants.map((p) => (
      <ProviderAvatar
        className="ring-1 ring-white/80"
        identity={p}
        key={p}
        size="xs"
      />
    ))}
  </div>
  <p className="min-w-0 flex-1 truncate text-xs text-slate-500">
    {previews.find((p) => p.text)?.text || "尚无消息"}
  </p>
</div>
```

**Step 4 — 给外层 `<button>` 加 `title` 属性（AC-15，悬停原生 tooltip）：**

```tsx
<button
  title={`创建 ${createdAtLabel} · 最后活动 ${updatedAtLabel} · ${messageCount} 条消息`}
  className={...}
  ...
>
```

**Step 5 — 调用侧更新（`SessionSidebar` 内 2 处 `<SessionCard ... />`）：**

```tsx
<SessionCard
  key={group.id}
  groupId={group.id}
  roomId={group.roomId}
  title={group.title}
  updatedAtLabel={group.updatedAtLabel}
  createdAtLabel={group.createdAtLabel}
  messageCount={group.messageCount}
  unreadCount={unreadCounts[group.id] ?? 0}
  participants={group.participants}
  previews={group.previews}
  active={activeGroupId === group.id}
  running={runningGroupIds.has(group.id)}
  isPinned={pinned.has(group.id)}  // or true for pinnedItems block
  onSelect={selectGroup}
  onCtxMenu={handleContextMenu}
/>
```

**Step 6 — 手工验证（AC-11/12/15）：**
- `cd ../Multi-Agent && pnpm dev`（或已启动的预览环境）
- 打开 http://localhost:3000，观察 sidebar：
  - 每条目左侧显示 `R-xxx` 等宽琥珀色前缀
  - 条目下方 avatar 堆叠 = 实际发过消息的 agents（空 group 显示"尚无 agent 参与"）
  - 鼠标悬停 2s，浏览器原生 tooltip 显示 `创建 ... · 最后活动 ... · N 条消息`

**Step 7 — Commit:**
```bash
git add components/chat/session-sidebar.tsx
git commit -m "feat(F022-P3): SessionCard — R-xxx · title 前缀 + 真实参与者头像 + 悬停详情 (AC-11/12/15)"
```

---

### Task 6: ROOM ID 搜索跳转（AC-13）

**Files:**
- Modify: `components/chat/session-sidebar.tsx`（扩展 `filtered` useMemo + 识别 R-xxx 模式）

**Step 1 — 在 `SessionSidebar` 组件内新增 helper（放在 `filtered` useMemo 之前）：**

```typescript
const ROOM_ID_PATTERN = /^r-?0*(\d+)$/i

function matchRoomId(query: string): string | null {
  const m = query.trim().match(ROOM_ID_PATTERN)
  if (!m) return null
  const num = m[1].padStart(3, "0")
  return `R-${num}`
}
```

**Step 2 — 替换 `filtered` useMemo：**

```typescript
const filtered = useMemo(() => {
  const raw = search.trim()
  if (!raw) return sessionGroups
  const roomTarget = matchRoomId(raw)
  if (roomTarget) {
    // ROOM ID 精确匹配优先；未命中则返回空列表提示"无此房间"
    return sessionGroups.filter((g) => g.roomId === roomTarget)
  }
  const query = raw.toLowerCase()
  return sessionGroups.filter(
    (group) =>
      group.title.toLowerCase().includes(query) ||
      group.previews.some((p) => p.text.toLowerCase().includes(query)),
  )
}, [sessionGroups, search])
```

**Step 3 — 自动选中（若搜索命中唯一 ROOM ID 且不是当前 active）：**

在 `SessionSidebar` 内加 effect：

```typescript
useEffect(() => {
  const raw = search.trim()
  const roomTarget = matchRoomId(raw)
  if (!roomTarget) return
  const hit = sessionGroups.find((g) => g.roomId === roomTarget)
  if (hit && hit.id !== activeGroupId) {
    void selectGroup(hit.id)
  }
}, [search, sessionGroups, activeGroupId, selectGroup])
```

**Step 4 — 空结果提示（R-999 无匹配时）：**

在 `{pinnedItems.length > 0 && ...}` 之前加：

```tsx
{filtered.length === 0 && search.trim() !== "" && (
  <div className="px-2 py-4 text-center text-xs text-slate-400">
    {matchRoomId(search)
      ? `未找到房间 ${matchRoomId(search)}`
      : "无匹配会话"}
  </div>
)}
```

**Step 5 — 手工验证（AC-13）：**
- 搜索框输入 `R-042` → 列表只剩 R-042 + 自动选中
- 输入 `r42` → 同上（大小写 + 无 `-` 容错）
- 输入 `R-999`（不存在） → 显示"未找到房间 R-999"
- 清空搜索 → 列表恢复

**Step 6 — Commit:**
```bash
git add components/chat/session-sidebar.tsx
git commit -m "feat(F022-P3): 搜索识别 R-xxx 精确跳转 + 自动选中 (AC-13)"
```

---

### Task 7: Agent 过滤 pills（AC-14）

**Files:**
- Modify: `components/chat/session-sidebar.tsx`

**Step 1 — 新增 state 与 toggle：**

在 `pinned` state 旁边：

```typescript
const [agentFilter, setAgentFilter] = useState<Set<Provider>>(new Set())

const toggleAgentFilter = useCallback((p: Provider) => {
  setAgentFilter((prev) => {
    const next = new Set(prev)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    return next
  })
}, [])
```

**Step 2 — 渲染 pills（搜索框下、Pinned 区上）：**

```tsx
<div className="mb-2 flex items-center gap-1.5 px-1">
  <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
    Agents
  </span>
  {(["claude", "codex", "gemini"] as Provider[]).map((p) => {
    const active = agentFilter.has(p)
    return (
      <button
        key={p}
        onClick={() => toggleAgentFilter(p)}
        type="button"
        className={`flex items-center rounded-full p-0.5 transition ${
          active ? "ring-2 ring-amber-400" : "opacity-60 hover:opacity-100"
        }`}
        title={`过滤 ${p} 参与的房间`}
      >
        <ProviderAvatar identity={p} size="xs" />
      </button>
    )
  })}
  {agentFilter.size > 0 && (
    <button
      onClick={() => setAgentFilter(new Set())}
      type="button"
      className="ml-auto text-[10px] text-slate-400 hover:text-slate-600"
    >
      清除
    </button>
  )}
</div>
```

**Step 3 — 把 filter 并入 `filtered` useMemo（加一层 participants 过滤，AND 关系 = 所有选中 agent 都参与）：**

```typescript
const filtered = useMemo(() => {
  let list = sessionGroups
  if (agentFilter.size > 0) {
    list = list.filter((g) => [...agentFilter].every((p) => g.participants.includes(p)))
  }
  const raw = search.trim()
  if (!raw) return list
  const roomTarget = matchRoomId(raw)
  if (roomTarget) return list.filter((g) => g.roomId === roomTarget)
  const query = raw.toLowerCase()
  return list.filter(
    (group) =>
      group.title.toLowerCase().includes(query) ||
      group.previews.some((p) => p.text.toLowerCase().includes(query)),
  )
}, [sessionGroups, search, agentFilter])
```

**Step 4 — 手工验证（AC-14）：**
- 点 claude 头像 → 列表只剩 claude 参与过的房间
- 再点 codex → 只剩 claude AND codex 都参与过的房间
- 点"清除" → 恢复

**Step 5 — Commit:**
```bash
git add components/chat/session-sidebar.tsx
git commit -m "feat(F022-P3): agent 头像过滤 pills — 多选 AND 过滤参与房间 (AC-14)"
```

---

### Task 8: Feature doc 同步 + Phase 3 完工标记

**Files:**
- Modify: `docs/features/F022-left-sidebar-redesign.md:55-60`（AC-11~15 打勾）
- Modify: `docs/features/F022-left-sidebar-redesign.md:89-98`（Timeline 加一行）

**Step 1 — 勾选 AC-11~15：**

```diff
- - [ ] AC-11: 条目显示 `R-xxx · {语义 title}`（ID 在前，title 紧跟）
- - [ ] AC-12: 条目下方显示 agent 头像堆叠（参与过本房间的 agents）
- - [ ] AC-13: 搜索框输入 `R-042` 直跳该房间（支持 ID 精确匹配优先）
- - [ ] AC-14: 搜索支持按 agent 过滤（点头像过滤参与房间）
- - [ ] AC-15: 条目悬停显示完整信息（创建时间 / 最后活动 / 消息数）
+ - [x] AC-11: 条目显示 `R-xxx · {语义 title}`（等宽琥珀色前缀 + 中点分隔）
+ - [x] AC-12: 条目下方显示 agent 头像堆叠（participants = 发过消息的 provider，不含空 thread）
+ - [x] AC-13: 搜索框输入 `R-042` 直跳（`/^R-?0*\d+$/i` 三形态识别 + 自动 selectGroup）
+ - [x] AC-14: 搜索支持 agent 过滤（头像 pills，多选 AND）
+ - [x] AC-15: 条目悬停显示完整信息（原生 title 属性：创建 · 最后活动 · N 条消息）
```

**Step 2 — Timeline 加一行：**

```
| 2026-04-20 | Phase 3 完成（AC-11~15） — sidebar UI 重塑（R-xxx 前缀 + participants 头像 + ROOM 搜索 + agent 过滤 + 悬停详情）|
```

**Step 3 — Commit:**
```bash
git add docs/features/F022-left-sidebar-redesign.md docs/plans/F022-phase3-plan.md
git commit -m "docs(F022): Phase 3 完成标记（AC-11~15 ✅）+ 实施计划入库"
```

---

## 合入决策（铁律：feature 未完工不合 dev）

Phase 3 完工后 **不合 dev**。继续 Phase 4（AC-16~18 顶部 ROOM 徽章 / ChatHeader / roomId 元数据）+ Phase 5（AC-19~21 三方验收）。全 feature ✅ + worktree 验收通过后由 `feat-lifecycle` completion 一次性合 dev。

## Out of Scope (Phase 3)

- AC-16~18 ChatHeader 顶部 ROOM 徽章（Phase 4）
- AC-19~21 桂芬视觉 / 范德彪 review / 小孙搜索验收（Phase 5）
- 虚拟滚动（列表 <200，YAGNI）
- 搜索历史 / 最近访问（未在 spec 中）
- pinned section 内的 ROOM ID 排序（保持按 updatedAt；若验收反馈需要按 roomId 再改）

## Risks / Watch

- **participants 语义变化**：原 `previews` 只按"最后消息 provider"渲染 avatar（可能只有 1 个），现在 `participants` 是"所有发过消息的 provider"（1-3 个），视觉密度会增加。若桂芬验收反馈过挤，考虑限制 max 3 + "+N" 省略。
- **messageCount 性能**：新增 per-thread `COUNT(*)` subquery。当前列表 <200 group × 3 thread = 600 次 COUNT，SQLite 有索引（threads.id → messages.thread_id）应可控。若 perf 日志 >50ms，考虑单次 `GROUP BY thread_id COUNT` 再 JOIN。
- **ROOM ID 自动跳转 UX**：输入 `R-0` 就会命中 `R-001`，每打一个字符可能触发 selectGroup。可考虑 300ms debounce 或仅在完整输入（如 3 位以上数字）才跳。留观察。

## Links

- Feature doc: `docs/features/F022-left-sidebar-redesign.md`
- Phase 1 plan: `docs/plans/F022-phase1-plan.md`
- Phase 2 plan: `docs/plans/F022-phase2-plan.md`
- 视觉 mock: `docs/left-sidebar-redesign-huang.html` / `docs/left-sidebar-redesign-huang.png`
