# F028 Workspace Explorer Tabs Implementation Plan

> v2 —— 吸收德彪 codex r1 文档审 9 findings（进程所有权/控制面合同/API 链靶向重启/零 dotenv/409/精确 denylist/摘要补未提交/Design Gate 条件放行）。

**Feature:** F028 — `docs/features/F028-workspace-explorer-tabs.md`
**Goal:** RuntimeLog 一级 tab 扩展位首次兑现——「Worktree」（列表/进展/编译后端/整组重启/UI 启动/打开前端）+「项目目录」（containment 同源文件树 + 只读看内容），小孙工作区自助可视、自助驱动。
**Acceptance Criteria:** AC1-AC10 以 feature doc（r2 版）为唯一真相源，本 plan 全覆盖：
- AC1 项目目录树（根可切）+ 只读内容
- AC2 list/read 同源 containment + 精确 denylist 隐藏 + 资源上限（二进制拒/512KB 截断/单目录 1000 条/5s 超时）
- AC3 Worktree 列表 + preview 状态（端口探测 + 所有权三态）
- AC4 进展摘要（branch/HEAD/10 commits/merge-base diff stat/staged-unstaged-untracked 计数）
- AC5 「编译后端」靶向重启 API 链（next dev 不动）+「重启整个 preview」独立次级操作 + 按钮态 + 日志尾部
- AC6 控制面安全合同（name 单源/无 shell 拼接/POST+同源/审计日志/主库端口数据保护/localhost 信任模型）
- AC7 UI 启动未运行 preview（registry 分配端口）
- AC8 「打开前端」一键新窗口（webPort 来自 registry）
- AC9 进程所有权（pid+birthTime 状态文件匹配才杀/外来 listener 拒/boot reconcile/UI 路径零 .env* 写入）
- AC10 同 worktree 操作单飞，第二发 409

**Architecture:** 后端 `packages/api/src/worktrees/`（inventory / guards / state-store+audit / orchestrator / deps / summary，路由 `routes/worktrees.ts`）+ `packages/api/src/project-tree/`（roots / list / content，复用 `wiki/path-containment.ts#readContainedFile`，路由 `routes/project-tree.ts`）。前端扩展 `runtime-log-store` LVL1（"worktrees"/"project-tree"），`runtime-log/index.tsx` 按 activeLvl1 切面板，新组件 `tabs/worktrees/` `tabs/project-tree/`。
**Tech Stack:** Fastify（现有 server.ts 模式）、node:child_process detached spawn（args 数组，无 shell 拼接）、taskkill /PID /T /F、PowerShell Get-Process StartTime（birthTime）、node:test + tsx（后端）、vitest + testing-library（前端）。
**F024 复用边界（实测定型）**：`packages/api` tsconfig `rootDir:"src"` 不能 import 仓库根 `scripts/`——registry 操作走 F024 现成**跨进程 worker**（`worktree-port-registry-claim-worker.ts` stdout JSON / `worktree-preview-shutdown-worker.ts`，shutdown-worker 同款模式）；`buildPreviewEnv` 纯映射**迁移到 `packages/shared/src/preview-env.ts`**（单一真相源），`scripts/worktree-preview.ts` 改为 re-export（F024 既有测试零改动保持绿），api 从 `@multi-agent/shared` 导入。

---

## 终态 Schema

### 进程模型（D6/D7/D9 · AC5/AC9 核心）

- 主 API 编排器**分别** spawn 两个 detached 子进程（不是 supervisor 整组）：
  - api: `pnpm dev:api`（链 = mount-skills → tsc shared → tsc api → tsx watch）
  - web: `pnpm dev:web`（next dev）
  - cwd = worktree 根（服务端从 `git worktree list` 解析，调用方只给 name）
  - env = `process.env` + `buildPreviewEnv(...)` 子进程注入（**UI 路径零 `.env*` 写入** —— 不调 prepareDotenv）
  - stdio → `<主仓>/.runtime/worktree-preview-ui/<name>-api.log` / `<name>-web.log`（append）
- 状态文件 `<主仓>/.runtime/worktree-preview-ui/<name>.json`：

```typescript
type PreviewState = {
  worktreeName: string
  apiPort: number
  webPort: number
  processes: {
    api: { pid: number; birthTime: string; startedAt: string } | null
    web: { pid: number; birthTime: string; startedAt: string } | null
  }
}
```

- **杀进程唯一合法依据**：目标 pid 在状态文件中且 OS 实测 birthTime 与记录一致 → `taskkill /PID <pid> /T /F`。端口被外来进程占用 → 拒绝操作返回 `PORT_OCCUPIED_FOREIGN`（绝不按端口/进程名杀）。
- **boot reconciliation**：主 API 启动时扫描状态文件，pid 不存在或 birthTime 失配 → 该 process 字段置 null（只清记录，不杀任何进程）。
- **并发单飞**：编排器内存 per-name 互斥；持锁期间任何同名操作 → 409。
- **审计**：每次操作 append 一行 JSON 到 `.runtime/worktree-preview-ui/audit.log`：`{time, action, worktree, ok, stage?, message?}`。

### Backend API

```typescript
// GET /api/worktrees（AC3）
type WorktreeListResponse = {
  worktrees: Array<{
    name: string; branch: string; head: string; path: string; isMain: boolean
    preview: {
      apiPort: number; webPort: number
      apiAlive: boolean; webAlive: boolean        // 端口探测
      ownership: "ui" | "foreign" | "none"        // 状态文件 pid+birthTime 实测三态
    } | null                                       // registry 无条目 = null
  }>
}

// GET /api/worktrees/:name/summary（AC4）
type WorktreeSummaryResponse = {
  branch: string; head: string
  commits: Array<{ hash: string; subject: string; date: string }>   // 10 条
  diffStat: { baseRef: string; files: number; insertions: number; deletions: number } // merge-base dev HEAD
  working: { staged: number; unstaged: number; untracked: number }  // git status --porcelain 解析
}

// POST /api/worktrees/:name/preview/compile-backend  （AC5 主操作：只动 api 子进程）
// POST /api/worktrees/:name/preview/restart           （AC5 次级：api+web 全组）
// POST /api/worktrees/:name/preview/start             （AC7：未运行时整组启动）
type PreviewActionResponse =
  | { ok: true; apiPort: number; webPort: number }
  | { ok: false; stage: "occupied-foreign" | "kill" | "spawn" | "ready-timeout" | "in-progress"; message: string }
// in-progress → HTTP 409；其余业务失败 HTTP 200 + ok:false

// GET /api/worktrees/:name/preview/log?proc=api|web&lines=120（AC5）
type PreviewLogResponse = { lines: string[]; logPath: string }
```

- 操作端点：POST + 同源校验（Origin 存在且 host 不匹配请求 Host → 403）+ name 必须命中 inventory（杜绝注入）+ isMain 400。
- AC8 打开前端：纯前端 `window.open("http://localhost:" + webPort)`，webPort 只能来自 list 响应。

### 项目目录 API（AC1/AC2）

```typescript
// GET /api/project-tree/roots → { roots: [{ id: "main" | "wt:<name>", label }] }
// GET /api/project-tree/list?root=main&dir=packages/api/src
//   → { entries: [{ name, type: "dir"|"file", size: number|null }] }  // 上限 1000 条
// GET /api/project-tree/content?root=main&path=packages/api/src/config.ts
//   → { content, mtime, truncated }  // >512KB 截断；NUL 嗅探 → 400 BINARY_FILE；5s 超时 → 504
```

- root 解析单源：`{lexicalRoot, expectedRealRoot}` 一次解析，list/content 共用（同源 containment）。
- list：`opendir` + 每 entry `lstat`，symlink/junction 不跟随不出现；dir 词法+realpath 双校验。
- content：薄包装 `readContainedFile(abs, root, expectedRealRoot)`（原语已含 realpath/单 fd/nlink 防御）。
- **denylist（D8 常量，list 隐藏 + content 404 同源判定）**：
  目录 `node_modules` `.git` `.next` `.npm-cache` `.worktrees` `.runtime` `.agents` `data` `.codex` `.gemini` `.obsidian`；
  文件 `.env*` `auth.json` `*.pem` `*.key` `*.p12` `*.pfx` `id_rsa*` `*.token` `.npmrc`。

### 前端

```typescript
export type RuntimeLogLvl1Key = "system-prompt" | "worktrees" | "project-tree" | "logs"
RUNTIME_LOG_LVL1_ITEMS = [
  { key: "system-prompt", label: "记忆系统", enabled: true },
  { key: "worktrees", label: "Worktree", enabled: true },       // Phase 1
  { key: "project-tree", label: "项目目录", enabled: true },     // Phase 2
  { key: "logs", label: "日志", enabled: false, futureTag: true },
]
```

- `index.tsx`：activeLvl1 切三面板，沿用 always-render + display:none（F027 r2 P2-1 契约：fetch/scroll 状态保持）。
- WorktreesTab 按钮区（per 选中行）：`[编译后端]` `[重启整个 preview]`（次级样式）`[打开前端]`（running 才显示）`[启动]`（未运行才显示）；操作中全按钮禁用 + spinner；失败显示 message + 自动拉日志尾部。

### 不做什么

- 不做 L2 staging UI、不做 worktree 创建/删除/切分支、不做文件编辑、不动 F024 CLI 路径（叠加不替换）、不引入账号体系（D10）、不做文件 watch 推送/搜索/语法高亮库引入。

---

## Phase 1 · Worktree tab（AC3-AC10）

### Task 0: buildPreviewEnv 迁 packages/shared（单一真相源，F024 契约保持）

**Files:**
- Create: `packages/shared/src/preview-env.ts`（+ `packages/shared/src/index.ts` re-export）
- Modify: `scripts/worktree-preview.ts`（删本地实现，改 `export { buildPreviewEnv, type PreviewEnv } from "../packages/shared/src/preview-env"`）
- Test: shared 侧新增 `packages/shared/src/preview-env.test.ts`（迁移既有断言）；**`scripts/worktree-preview.test.ts` 零改动必须保持绿**（F024 契约回归证明）

**Steps:** 失败测试（shared 侧 import 断言 env 映射全字段）→ 迁移 → `pnpm test:api` 确认 F024 测试原样绿 → Commit
`refactor(F028): buildPreviewEnv 迁 shared 单源——scripts re-export 保 F024 契约 [黄仁勋]`

### Task 1: worktree 枚举器

**Files:** Create `packages/api/src/worktrees/worktree-inventory.ts` + test
**失败测试用例**（deps 全注入：execGit/readRegistry/probePort/readState/probeBirthTime）：
1. porcelain 3 worktree（含主仓）→ name/branch/head/path/isMain
2. registry 有条目 + 双端口活 + 状态文件 pid+birthTime 实测匹配 → ownership:"ui"
3. 端口活但无状态文件（或 birthTime 失配）→ ownership:"foreign"
4. registry 有条目端口全死 → apiAlive/webAlive=false, ownership:"none"
5. registry 无条目 → preview:null
6. detached HEAD 块 → branch:"(detached)" 不抛
**TDD 循环 → Commit** `feat(F028): worktree 枚举器——porcelain+registry+端口探测+所有权三态 [黄仁勋]`

### Task 2: 安全边界原语（AC6/AC9 守门）

**Files:** Create `packages/api/src/worktrees/preview-guards.ts` + test
**失败测试用例**：
1. `assertWorktreePort`: 8800/8801/3100/3101 过；8787/3000/80/0/-1 抛
2. `assertOperableWorktree`: isMain 抛；name 不在 inventory 抛；正常返回 entry
3. `assertOwnedProcess(rec, osBirthTime)`: birthTime 一致过；失配/记录 null 抛 `NotOwnedError`
4. `assertSameOrigin(originHeader, hostHeader)`: 无 Origin（同源非浏览器 curl）过；Origin host==Host 过；跨源抛
**TDD → Commit** `feat(F028): preview 安全原语——端口/对象/所有权/同源四重断言 [黄仁勋]`

### Task 3: 状态文件存取 + 审计日志 + boot reconcile

**Files:** Create `packages/api/src/worktrees/preview-state.ts` + test
**失败测试用例**（fs 注入 tmpdir 真文件）：
1. writeState/readState round-trip；损坏 JSON → null 不抛
2. `appendAudit` 追加一行 JSON（含 time/action/worktree/ok）
3. `reconcileOnBoot`: pid 不存在 → process 字段置 null 落盘；birthTime 失配 → 同；匹配 → 原样；**全程不调 kill**（注入 kill spy 断言 0 调用）
**TDD → Commit** `feat(F028): preview 状态文件+审计日志+boot reconcile（只清记录不杀进程）[黄仁勋]`

### Task 4: preview 编排器（compile-backend / restart / start / log / 409）

**Files:** Create `packages/api/src/worktrees/preview-orchestrator.ts` + test
**失败测试用例**（deps 全注入零真 IO）：
1. `compileBackend` happy：杀 owned api 进程树 → spawn dev:api → api 端口 ready → ok:true；**web 进程 deps 零调用**（靶向断言）
2. `compileBackend` 端口被 foreign 占 → `{ok:false, stage:"occupied-foreign"}`，kill 零调用
3. `restartAll` happy：api+web 都按所有权杀 → 双 spawn → 双端口 ready → ok:true
4. `start` 已 running(ownership:ui) → ok:false in-progress 语义外：返回 already-running message（spawn 零调用）
5. `start` 无 registry 条目 → claimPorts 被调（端口动态分配）→ spawn → ok:true
6. ready-timeout → 已 spawn 子进程按 pid+birthTime 回收，状态文件回滚
7. spawn 抛 → `{ok:false, stage:"spawn"}` 状态文件不留半截
8. **AC6**: 注入 8787 listener 构造 → 任何 kill 前断言抛（PreviewGuardError），审计记录 ok:false
9. **AC10**: 同名并发第二发 → `{ok:false, stage:"in-progress"}`（内存锁），异名并行互不挡
10. 每操作（成败均）appendAudit 恰一次
11. `tailLog(name, proc, lines)`: 文件存在尾 N 行；不存在 lines:[]
**TDD → Commit** `feat(F028): preview 编排器——靶向编译后端/整组重启/启动/409/审计 [黄仁勋]`

### Task 5: 编排真实 deps（Windows 适配层）

**Files:** Create `packages/api/src/worktrees/preview-deps.ts` + test
**失败测试用例**（纯函数解析 + 命令拼装，不跑真命令）：
1. `parseGetProcessBirthTime(stdout)`: PowerShell `Get-Process -Id X | Select StartTime` 样本 → ISO 串；进程不存在样本 → null
2. `buildTaskkillArgs(pid)` → `["/PID", String(pid), "/T", "/F"]`（args 数组无拼接）
3. `buildSpawnSpec("api"|“web", worktree, env)` → cwd=worktree.path、detached:true、stdio 指向 `<name>-api.log`、command="pnpm" args=["dev:api"]、**spec.env 含 buildPreviewEnv（@multi-agent/shared）注入且不含 prepareDotenv 调用痕迹**
4. `parsePortListeners(netstatStdout, [8801,3101])` → pid 集合（仅用于 foreign 检测，永不作为 kill 输入）
5. `buildClaimWorkerSpec(registryPath, name)` → command="npx" args=["tsx","scripts/worktree-port-registry-claim-worker.ts",...]（claim 走 F024 跨进程 worker，stdout JSON 解析为 PortEntry；解析坏 JSON → 结构化 error）
6. `buildShutdownWorkerSpec(registryPath, name)` → 同款（registry 清理走 F024 shutdown-worker）
**TDD → Commit** `feat(F028): preview 真实 deps——birthTime/taskkill/detached spawn/netstat 解析 [黄仁勋]`

### Task 6: 进展摘要

**Files:** Create `packages/api/src/worktrees/worktree-summary.ts` + test
**失败测试用例**（execGit 注入）：
1. log --format 解析 10 条 {hash,subject,date}
2. `merge-base dev HEAD` → base，`diff --shortstat <base> HEAD` 解析三元组；空输出 → 全 0
3. `status --porcelain` 解析：staged（首列非空非?）/unstaged（次列非空）/untracked（??）计数；同行双列各计一次
4. git 报错 → 结构化 `{error}` 不抛裸异常
**TDD → Commit** `feat(F028): worktree 进展摘要——commits+merge-base diffstat+未提交三计数 [黄仁勋]`

### Task 7: routes/worktrees.ts + server.ts 挂载 + boot reconcile 接线

**Files:** Create `packages/api/src/routes/worktrees.ts` + test；Modify `packages/api/src/server.ts`
**失败测试用例**（fastify.inject + fake 模块）：
1. GET /api/worktrees → 200 inventory 透传
2. GET /:name/summary 未知 name → 404
3. POST main/preview/compile-backend → 400（isMain）
4. POST 带跨源 Origin → 403
5. POST compile-backend fake ok:true → 200；fake in-progress → **409**；fake 其他 ok:false → 200 body.ok=false
6. GET log?proc=web → 200 透传；proc 非法值 → 400
7. name "../x" → 400（inventory 名单外）
8. server 启动路径调用 reconcileOnBoot 恰一次（bootstrap spy）
**TDD → Commit** `feat(F028): worktrees 路由+同源校验+409 映射+boot reconcile 接线 [黄仁勋]`

### Task 8: 前端 store 扩展（"worktrees"）

**Files:** Modify `components/stores/runtime-log-store.ts` + test
**用例**：LVL1_ITEMS 含 worktrees enabled / setActiveLvl1("worktrees") 生效 / logs 仍 disabled 不可激活
**TDD → Commit** `feat(F028): LVL1 注册 Worktree tab [黄仁勋]`

### Task 9: WorktreesTab UI + hook + index.tsx 内容切换

**Files:** Create `tabs/worktrees/worktrees-tab.tsx` `tabs/worktrees/use-worktrees-api.ts`；Modify `runtime-log/index.tsx`；+ test
**失败测试用例**（fetch mock）：
1. 列表：2 worktree + 端口/双活徽章/ownership 标签；主仓行无操作钮
2. 选中 → summary 渲染（commits/diffstat/未提交三计数）
3. `[编译后端]` 点击 → 按钮组禁用+spinner → ok:true → 成功态 + 列表刷新
4. ok:false(occupied-foreign) → 失败条 + message + 日志尾部自动展开
5. 409 → "操作进行中"提示不重发
6. 未运行行：`[启动]` 显示、`[编译后端]/[打开前端]` 不显示；running 行反之
7. `[打开前端]` → window.open 被调且 URL=http://localhost:<webPort>（spy）
8. lvl1 切到 worktrees 才首次 fetch（懒加载）
**TDD → Commit** `feat(F028): WorktreesTab——列表/摘要/编译后端/整组重启/启动/打开前端/日志 [黄仁勋]`

### Task 10: Phase 1 集成验证（真机）

1. 本 feature worktree 起 preview（CLI 路径，F024 现状）
2. Worktree tab 列出全部 worktree；对测试 worktree UI `[启动]` → running + ownership:"ui"
3. `[编译后端]` → api log 出现 tsc 链输出、web 进程 pid 前后不变（靶向实证）
4. `[重启整个 preview]` → 双进程 pid 都变
5. 主库 :8787/:3000 pid 前后对照不变（AC6 实证）；audit.log 有全部操作记录
6. 截图落 `.agents/acceptance/F028/`

## Phase 2 · 项目目录 tab（AC1-AC2）

### Task 11: 根解析器（单源）

**Files:** Create `packages/api/src/project-tree/tree-roots.ts` + test
**用例**：main→主仓 {lexicalRoot, expectedRealRoot}；wt:<name>→worktree 根；未知/已删→null；realpath 失败→null
**TDD → Commit** `feat(F028): project-tree 根解析器——main/worktree 单源 realpath [黄仁勋]`

### Task 12: 目录 list（containment + denylist + 上限）

**Files:** Create `packages/api/src/project-tree/tree-list.ts` + test（真 tmpdir fixture 含 symlink/secrets）
**用例**：
1. 排序（dir 前、字母序）+ size 仅 file
2. D8 目录 denylist 不出现；`.env`/`.env.local`/`auth.json`/`x.pem`/`id_rsa.pub`/`.npmrc` 不出现
3. 树外 symlink 不出现不抛；dir="../" → WikiPathInvalidError；dir 为树内 junction → 400 语义错误
4. root swap（expectedRealRoot 失配）→ 400
5. >1000 条目录 → 截到 1000 + truncated 标记
**TDD → Commit** `feat(F028): project-tree list——containment+精确 denylist+条目上限 [黄仁勋]`

### Task 13: 文件 content（readContainedFile 复用 + 策略层）

**Files:** Create `packages/api/src/project-tree/tree-content.ts` + test
**用例**：正常 .ts → content+mtime；denylist 路径 → null（404 语义，与隐藏同源判定）；>512KB → 截断+truncated；NUL 字节 → BINARY_FILE；5s 超时（注入慢 read）→ TIMEOUT；越界 → WikiPathInvalidError 透传（只测分流不重测原语）
**TDD → Commit** `feat(F028): project-tree content——复用原语+截断/二进制/超时策略 [黄仁勋]`

### Task 14: routes/project-tree.ts + server 挂载

**Files:** Create `packages/api/src/routes/project-tree.ts` + test；Modify `packages/api/src/server.ts`
**用例**：roots/list/content 200 透传；越界 → 400；不存在 → 404；BINARY_FILE → 400；TIMEOUT → 504
**TDD → Commit** `feat(F028): project-tree 路由+server 挂载 [黄仁勋]`

### Task 15: 前端 store + ProjectTreeTab

**Files:** Modify `runtime-log-store.ts`、`runtime-log/index.tsx`；Create `tabs/project-tree/project-tree-tab.tsx` `use-project-tree-api.ts`；+ test
**用例**：根切换器渲染 roots；懒加载展开 + 子目录缓存；点文件 → `<pre>` 内容 + mtime；truncated 提示条；400/404 错误条不崩；lvl1 切到才 fetch roots
**TDD → Commit** `feat(F028): ProjectTreeTab——根切换/懒加载树/只读内容 [黄仁勋]`

### Task 16: Phase 2 集成验证（真机）

1. 浏览主仓根 + worktree 根；实点 config.ts 看内容
2. 全树确认 `.env*` 不可见；`curl content?path=../../x` → 400；`curl content?path=.env` → 404
3. 截图落 `.agents/acceptance/F028/`

## 收尾链（plan 外，由对应 skill 接管）

quality-gate → acceptance-guardian（worktree preview 环境）→ requesting-review（德彪真 codex）→ receiving-review → merge-gate → feat-lifecycle Completion。

## 风险与对策

| 风险 | 对策 |
|------|------|
| Windows 杀树不净（pnpm→npm→tsx 链） | taskkill /T 树杀 + 杀后端口复探确认空 + 启动前 occupied-foreign 检查兜底 |
| detached 子进程随主 API 重启失联 | 状态文件 pid+birthTime 持久化；boot reconcile 重建视图；running 真相=端口探测+所有权实测 |
| birthTime 精度/时区导致误判 foreign | birthTime 统一 ISO UTC 落盘；比较容差 ±2s（进程表查询精度） |
| spawn 类测试 flaky | 编排器/inventory 测试全 deps 注入零真 IO；真 spawn 只在 Task 10/16 人工集成步 |
| registry 并发写 | 复用 F024 proper-lockfile 原语 |
| worktree preview 里的 API 实例也暴露管理端点 | 接受（同信任模型）；registry/状态文件路径解析单源主仓根，行为一致 |
