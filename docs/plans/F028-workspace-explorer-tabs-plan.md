# F028 Workspace Explorer Tabs Implementation Plan

> v5 —— 桂芬 gemini r5 接管修订：修正 SQLITE_PATH 首次启动 realpath 时序（验父目录）、Windows pnpm 启动适配（cmd.exe /c 数组）、项目树拒 NTFS ADS。

**Feature:** F028 — `docs/features/F028-workspace-explorer-tabs.md`
**Goal:** RuntimeLog 一级 tab 扩展位首次兑现——「Worktree」（列表/进展/编译后端/整组重启/UI 启动/打开前端）+「项目目录」（containment 同源文件树 + 只读看内容），小孙工作区自助可视、自助驱动。
**Acceptance Criteria:** AC1-AC10 以 feature doc（r2 版）为唯一真相源，本 plan 全覆盖：
- AC1 项目目录树（根可切）+ 只读内容
- AC2 list/read 同源 containment + 精确 denylist 隐藏 + 资源上限（二进制拒/512KB 截断/单目录 1000 条）
- AC3 Worktree 列表 + preview 状态（端口探测 + 所有权三态）
- AC4 进展摘要（branch/HEAD/10 commits/merge-base diff stat/staged-unstaged-untracked 计数）
- AC5 「编译后端」靶向重启 API 链（next dev 不动）+「重启整个 preview」独立次级操作 + 按钮态 + 日志尾部
- AC6 控制面安全合同（name 单源/无 shell 拼接/POST+同源/审计日志/主库端口数据保护/localhost 信任模型）
- AC7 UI 启动未运行 preview（registry 分配端口）
- AC8 「打开前端」一键新窗口（webPort 来自 registry）
- AC9 进程所有权（pid+CreationDate 状态文件匹配才杀/外来 listener 拒/boot reconcile/UI 路径零 .env* 写入）
- AC10 同 worktree 操作单飞，第二发 409

**Architecture:** 后端 `packages/api/src/worktrees/`（inventory / guards / state-store+audit / orchestrator / deps / summary，路由 `routes/worktrees.ts`）+ `packages/api/src/project-tree/`（roots / list / content，复用 `wiki/path-containment.ts#readContainedFile`，路由 `routes/project-tree.ts`）。前端扩展 `runtime-log-store` LVL1（"worktrees"/"project-tree"），`runtime-log/index.tsx` 按 activeLvl1 切面板，新组件 `tabs/worktrees/` `tabs/project-tree/`。
**Tech Stack:** Fastify（现有 server.ts 模式）、node:child_process detached spawn（args 数组，无 shell 拼接）、taskkill /PID /T /F、PowerShell Get-CimInstance Win32_Process、node:test + tsx（后端）、vitest + testing-library（前端）。
**F024 复用边界（实测定型）**：`packages/api` tsconfig `rootDir:"src"` 不能 import 仓库根 `scripts/`——registry 操作走 F024 现成**跨进程 worker**（`worktree-port-registry-claim-worker.ts` stdout JSON / `worktree-preview-shutdown-worker.ts`，shutdown-worker 同款模式）；`buildPreviewEnv` 纯映射**迁移到 `packages/shared/src/preview-env.ts`**（单一真相源），`scripts/worktree-preview.ts` 改为 re-export（F024 既有测试零改动保持绿），api 从 `@multi-agent/shared` 导入。

---

## 终态 Schema

### 进程模型（D6/D7/D9/D12/D13 · AC5/AC9 核心 · r2 升级版）

- **控制面单实例（D12 · r2 P1-2）**：控制路由（start/restart/compile-backend）、内存单飞锁、boot reconcile **只存在于主 API**——路由注册处以 `process.env.WORKTREE_PREVIEW` 为门禁（preview 实例该 env=1 → 不注册控制路由，只注册只读 GET）。preview UI 通过 `GET /api/worktrees/capabilities → {control:boolean}` 感知并禁用操作按钮（提示去主 UI）。否则 worktree 自己的 API 收到 compile-backend 会先杀自身进程树（自杀悖论），且多实例锁失效。
- **worktreeId（D13 · r2 P1-3/P2-1）**：`slugifyWorktreeId(name)` = `(sanitize(name) || "wt").slice(0,31) + "-" + sha1(name).slice(0,8)`。截断 sanitize 前缀确保总长 ≤40 字符以规避 Windows 文件路径深度限制。状态文件与日志文件均以 worktreeId 命名。
- 主 API 编排器**分别** spawn 两个 detached 子进程（不是 supervisor 整组）：
  - api: Windows 下为 `command="cmd.exe" args=["/d","/s","/c","pnpm dev:api"]`；POSIX 为 `command="pnpm" args=["dev:api"]`。**绝不使用 shell:true，全参数数组传递**。
  - web: 同上，args 对应 `dev:web`。
  - cwd = worktree 根（服务端从 `git worktree list` 解析，调用方只给 name）
  - env = `process.env` + `buildPreviewEnv(...)` 子进程注入（**UI 路径零 `.env*` 写入** —— 不调 prepareDotenv）
  - stdio → `<主仓>/.runtime/worktree-preview-ui/<worktreeId>-api.log` / `<worktreeId>-web.log`（append）
- 状态文件 `<主仓>/.runtime/worktree-preview-ui/<worktreeId>.json`：

```typescript
type PreviewState = {
  worktreeName: string        // 原始名（展示用）
  worktreeId: string          // 文件名/键 = slug (D13)
  apiPort: number
  webPort: number
  processes: {
    api: { pid: number; creationDate: string; startedAt: string } | null  // creationDate = CIM Win32_Process 同源采集
    web: { pid: number; creationDate: string; startedAt: string } | null
  }
}
```

- **杀进程唯一合法依据（r2 P1-4 升级）**：kill 前置预检三连——(1) 记录 pid 存在且 OS 实测 CreationDate 与落盘值**精确相等**（spawn 后与预检用同一 CIM 查询源，同表示精确比较，无容差；解析器提取 .NET JSON 格式中的整数 epoch-ms）；(2) 我们端口上的每个 listener pid 都是记录 pid 的**后代**（CIM 进程表 ppid 链向上溯达记录 pid）；(3) 端口断言（≥3100/≥8800 且 ≠3000/≠8787）。预检全过 → `taskkill /PID <记录pid> /T /F`；任一不过 → `PORT_OCCUPIED_FOREIGN` 拒绝（绝不按端口/进程名杀）。**整组重启在任何 kill 之前完成 api+web 双进程全量预检**（半杀不允许）。
- **SQLITE_PATH 包含性断言（r5 修正）**：spawn 前执行 **安全目录创建顺序**：(1) 逐级探测现存祖先路径（拒 symlink/junction）→ (2) `mkdir -p` 缺失段路径（确保 data 文件夹存在）→ (3) **对 data 文件夹 realpath** 并断言其位于 `<目标worktree>/.runtime/worktree-preview/` 内，且不等于/不落入主仓路径；(4) 最终 `SQLITE_PATH` = 该已验 realpath 文件夹 + 受控文件名 `multi-agent.sqlite`（规避首启文件不存在导致 realpath 抛错）。
- **boot reconciliation**：主 API 启动时扫描状态文件，pid 不存在或 CreationDate 失配 → 该 process 字段置 null（只清记录，不杀任何进程）。
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
      ownership: "ui" | "foreign" | "none"        // 状态文件 pid+CreationDate 实测三态
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

- 操作端点：POST + **精确控制面白名单解析器（r3 P1-2）**——使用独立的 `resolveControlPlaneOrigins()`：Origin 头存在时必须命中 {主 UI origin `http://localhost:3000`} ∪ {registry webPort origins 集合}。即使配置了宽松的 RegExp CORS，控制面也必须执行精确匹配以排除 API 端口自身。无 Origin（curl/同进程）放行（localhost 信任模型）；**绝不用 Origin==API Host**。+ name 必须命中 inventory（杜绝注入）+ isMain 400。
- `GET /api/worktrees/capabilities` → `{ control: boolean }`（主 API true / preview 实例 false，UI 据此禁用操作按钮）。
- AC8 打开前端：纯前端 `window.open("http://localhost:" + webPort)`，webPort 只能来自 list 响应。

### 项目目录 API（AC1/AC2）

```typescript
// GET /api/project-tree/roots → { roots: [{ id: "main" | "wt:<name>", label }] }
// GET /api/project-tree/list?root=main&dir=packages/api/src
//   → { entries: [{ name, type: "dir"|"file", size: number|null }] }  // 上限 1000 条
// GET /api/project-tree/content?root=main&path=packages/api/src/config.ts
//   → { content, mtime, truncated }  // 原语层 maxBytes=512KB 限读截断（r2 P1-6：同 fd 限读，不整读后截）；NUL 嗅探 → 400 BINARY_FILE
```

- root 解析单源：`{lexicalRoot, expectedRealRoot}` 一次解析，list/content 共用（同源 containment）。
- list：`opendir` + 每 entry `lstat`，symlink/junction 不跟随不出现；dir 词法+realpath 双校验。**拒绝包含 `:` 的相对路径（防 NTFS ADS）**。
- content：薄包装 `readContainedFile(abs, root, expectedRealRoot)`（原语已含 realpath/单 fd/nlink 防御）。**拒绝包含 `:` 的相对路径（防 NTFS ADS）**。
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
**失败测试用例**（deps 全注入：execGit/readRegistry/probePort/readState/probeCreationDate）：
1. porcelain 3 worktree（含主仓）→ name/branch/head/path/isMain
2. registry 有条目 + 双端口活 + 状态文件 pid+CreationDate 实测匹配 → ownership:"ui"
3. 端口活但无状态文件（或 CreationDate 失配）→ ownership:"foreign"
4. registry 有条目端口全死 → apiAlive/webAlive=false, ownership:"none"
5. registry 无条目 → preview:null
6. detached HEAD 块 → branch:"(detached)" 不抛
**TDD 循环 → Commit** `feat(F028): worktree 枚举器——porcelain+registry+端口探测+所有权三态 [黄仁勋]`

### Task 2: 安全边界原语（AC6/AC9 守门 · r2 升级 · r5 修订）

**Files:** Create `packages/api/src/worktrees/preview-guards.ts` + test
**失败测试用例**：
1. `assertWorktreePort`: 8800/8801/3100/3101 过；8787/3000/80/0/-1 抛
2. `assertOperableWorktree`: isMain 抛；name 不在 inventory 抛；正常返回 entry
3. `assertOwnedProcess(rec, osCreationDate)`: **精确相等**过；任何不等（含 1ms 差）/记录 null 抛 `NotOwnedError`
4. `resolveControlPlaneOrigins()`: 基于 registry 与配置，解析精确 Origin 白名单；**明确包含主 UI `http://localhost:3000`**；补默认 RegExp / string / array 三种 CORS 配置形态下的解析器测试。
5. `assertAllowedOrigin(originHeader, allowedOrigins)`: 无 Origin 过；命中白名单（:3000 主 UI / :3101 registry webPort）过；`http://localhost:8800`（API 自身 Host）**不在白名单 → 抛**（防回归到 Origin==Host）；`http://evil.com` 抛
6. `assertListenerDescendant(processTable, listenerPid, rootPid)`: ppid 链可达过；不可达抛；表中无 listener 抛；环形 ppid（防御）抛
7. `slugifyWorktreeId`: `feat/F028` → 无 `/` 且含 8 位哈希；**sanitize 前缀截断确保总长 ≤40**（`(sanitize(name) || "wt").slice(0,31) + "-" + sha1(name).slice(0,8)`）；超长名/纯 Unicode 名（sanitize 后可能为空）测试。
8. `assertSqlitePathContained(sqlitePath, worktreeRoot, mainDataPaths)`: **检查其父目录**。worktree preview data 内过；主仓 `data/` 内抛；等于主库路径抛；`..` 逃逸抛；**DB 文件尚不存在但父目录合法 → 过（r5 修正点）**。
9. `assertPathNoAds(path)`: 相对路径含 `:` 抛；不含过。
**TDD → Commit** `feat(F028): preview 安全原语——端口/对象/所有权/origin/后代/slug长度上限/sqlite及ADS断言 [黄仁勋]`

### Task 3: 状态文件存取 + 审计日志 + boot reconcile

**Files:** Create `packages/api/src/worktrees/preview-state.ts` + test
**失败测试用例**（fs 注入 tmpdir 真文件）：
1. writeState/readState round-trip（文件名 = worktreeId slug，name 为 `feat/x` 时不产生子目录）；损坏 JSON → null 不抛
2. `appendAudit` 追加一行 JSON（含 time/action/worktree/ok）
3. `reconcileOnBoot`: pid 不存在 → process 字段置 null 落盘；CreationDate 失配 → 同；匹配 → 原样；**全程不调 kill**（注入 kill spy 断言 0 调用）
**TDD → Commit** `feat(F028): preview 状态文件+审计日志+boot reconcile（只清记录不杀进程）[黄仁勋]`

### Task 4: preview 编排器（compile-backend / restart / start / log / 409）

**Files:** Create `packages/api/src/worktrees/preview-orchestrator.ts` + test
**失败测试用例**（deps 全注入零真 IO）：
1. `compileBackend` happy：预检（CreationDate 精确相等 + listener 后代链 + 端口断言）→ 杀 owned api 进程树 → spawn dev:api → api 端口 ready → ok:true；**web 进程 deps 零调用**（靶向断言）
2. `compileBackend` listener 非记录 pid 后代（注入外来 listener 进程表）→ `{ok:false, stage:"occupied-foreign"}`，kill 零调用
3. `compileBackend` CreationDate 差 1ms → `{ok:false, stage:"occupied-foreign"}`，kill 零调用（精确比较回归锚）
4. `restartAll` happy：**先完成 api+web 双进程全量预检，再开始任何 kill**（调用顺序断言：两次预检都在首个 kill 之前）→ 双杀双 spawn 双 ready → ok:true
5. `restartAll` web 预检失败 → api 也不杀（半杀禁止），ok:false
6. `start` 已 running(ownership:ui) → already-running（spawn 零调用）；**spawn 前增加双端口 foreign 探测，若任一被占 → `occupied-foreign` 且 spawn=0**。
7. `start` 无 registry 条目 → claim worker 被调（端口动态分配）→ spawn → ok:true
8. `start` spawn 前安全创建目录：**必须先逐级探测现存祖先路径（拒 symlink/junction）→ 再 `mkdir -p` 缺失段路径（确保 data 文件夹存在）→ 对已创文件夹 realpath 断言**（r5 修订）；junction 场景测试断言没有发生任何目录创建。
9. ready-timeout → 已 spawn 子进程按记录 pid+CreationDate 回收，状态文件回滚
10. spawn 抛 → `{ok:false, stage:"spawn"}` 状态文件不留半截
11. **AC6**: 注入 8787 listener 构造 → 任何 kill 前断言抛，审计 ok:false
12. **AC10**: 同名并发第二发 → `{ok:false, stage:"in-progress"}`（内存锁，单实例前提 = D12 控制面只在主 API），异名并行互不挡
13. 每操作（成败均）appendAudit 恰一次
14. `tailLog(name, proc, lines)`: 文件存在尾 N 行；不存在 lines:[]；日志路径由 worktreeId 构成（`feat/x` 不产生嵌套目录）
**TDD → Commit** `feat(F028): preview 编排器——靶向编译后端/整组重启/安全目录创建/409/审计 [黄仁勋]`

### Task 5: 编排真实 deps（Windows 适配层 · r5 修订）

**Files:** Create `packages/api/src/worktrees/preview-deps.ts` + test
**失败测试用例**（纯函数解析 + 命令拼装，不跑真命令）：
1. `parseCimProcessTable(stdout)`: `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CreationDate | ConvertTo-Json` 样本 → `{pid, ppid, creationDate}`（从 `\/Date(ms)\/` 提取整数 epoch-ms 用于精确相等比较）；进程不存在/空表样本 → []
2. `buildTaskkillArgs(pid)` → `["/PID", String(pid), "/T", "/F"]`（args 数组无拼接）
3. `buildSpawnSpec("api"|“web", worktree, env)`：
   - Windows: `command="cmd.exe" args=["/d","/s","/c","pnpm dev:api"]`（固定字面量，防注入）；
   - POSIX: `command="pnpm" args=["dev:api"]`；
   - 通用: `cwd=worktree.path`、`detached:true`、`stdio` 指向日志、`env` 含 `buildPreviewEnv` 注入且不含 `prepareDotenv` 调用。
4. `parsePortListeners(netstatStdout, [8801,3101])` → pid 集合（仅用于 foreign 检测，永不作为 kill 输入）
5. `buildClaimWorkerSpec({nodeExe,tsxCliPath,mainRoot,registryPath,worktreeName})` → command=`process.execPath`（node）args=[`<mainRoot>/node_modules/tsx/dist/cli.mjs`,`<mainRoot>/scripts/worktree-port-registry-claim-worker.ts`,registryPath,worktreeName]（**德彪 code r1 P1-1 修订**：废 npx/.cmd shim——npx 是 .cmd 脚本需 shell:true，worktree 名含 cmd 元字符即注入；node 直跑 tsx cli 纯 argv 数组、execFile 无 shell。claim 走 F024 跨进程 worker，stdout JSON 解析为 PortEntry；解析坏 JSON → 结构化 error）
6. `buildShutdownWorkerSpec({...})` → 同款 node 直跑形态（registry 清理走 F024 shutdown-worker）
**TDD → Commit** `feat(F028): preview 真实 deps——Windows cmd.exe 适配/taskkill/detached spawn [黄仁勋]`

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
4. POST Origin=`http://localhost:3000`（主 UI）→ 放行；Origin=`http://localhost:3101`（registry webPort 白名单）→ 放行；Origin=`http://localhost:8800`（API 自身）→ **403**；Origin=`http://evil.com` → 403；无 Origin → 放行
5. POST compile-backend fake ok:true → 200；fake in-progress → **409**；fake 其他 ok:false → 200 body.ok=false
6. GET log?proc=web → 200 透传；proc 非法值 → 400
7. name "../x" → 400（inventory 名单外）
8. server 启动路径调用 reconcileOnBoot 恰一次（bootstrap spy）
9. **D12 注册门禁**：`WORKTREE_PREVIEW=1` 构造下控制 POST 路由 404（未注册）、只读 GET 正常；无该 env 全注册；GET /api/worktrees/capabilities 分别返回 {control:false}/{control:true}
**TDD → Commit** `feat(F028): worktrees 路由+精确 Origin 校验+409 映射+boot reconcile 接线 [黄仁勋]`

### Task 8: 前端 store 扩展（"worktrees"）

**Files:** Modify `components/stores/runtime-log-store.ts` + test
**用例**：LVL1_ITEMS 含 worktrees enabled / setActiveLvl1("worktrees") 生效 / logs 仍 disabled 不可激活
**TDD → Commit** `feat(F028): LVL1 注册 Worktree tab [黄仁勋]`

### Task 9: WorktreesTab UI + hook + index.tsx 内容切换

**Files:** Create `tabs/worktrees/worktrees-tab.tsx` `tabs/worktrees/use-worktrees-api.ts`；Modify `runtime-log/index.tsx`；+ test
**失败测试用例**（fetch mock）：
1. 列表：2 worktree + 端口/双活徽章/ownership 标签；主仓行无操作钮。（**不含 CreationDate 渲染检查**）
2. 选中 → summary 渲染（commits/diffstat/未提交三计数）
3. `[编译后端]` 点击 → 按钮组禁用+spinner → ok:true → 成功态 + 列表刷新
4. ok:false(occupied-foreign) → 失败条 + message + 日志尾部自动展开
5. 409 → "操作进行中"提示不重发
6. 未运行行：`[启动]` 显示、`[编译后端]/[打开前端]` 不显示；running 行反之
7. `[打开前端]` → window.open 被调且 URL=http://localhost:<webPort>（spy）
8. lvl1 切到 worktrees 才首次 fetch（懒加载）
9. **D12**: capabilities {control:false} → 全部操作按钮禁用 + "去主 UI 操作"提示（只读列表/摘要正常）
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

### Task 12: 目录 list（containment + denylist + 上限 · r5 修订）

**Files:** Create `packages/api/src/project-tree/tree-list.ts` + test（真 tmpdir fixture 含 symlink/secrets）
**用例**：
1. 排序（dir 前、字母序）+ size 仅 file
2. D8 目录 denylist 不出现；`.env`/`.env.local`/`auth.json`/`x.pem`/`id_rsa.pub`/`.npmrc` 不出现
3. **拒 ADS**：相对路径含 `:` → 400
4. 树外 symlink 不出现不抛；dir="../" → WikiPathInvalidError；dir 为树内 junction → 400 语义错误
5. root swap（expectedRealRoot 失配）→ 400
6. >1000 条目录 → 截到 1000 + truncated 标记
**TDD → Commit** `feat(F028): project-tree list——ADS 防御+精确 denylist+条目上限 [黄仁勋]`

### Task 12.5: readContainedFile maxBytes 原语扩展（r2 P1-6）

**Files:** Modify `packages/api/src/wiki/path-containment.ts`（加法可选参数）+ 扩展其既有测试
**失败测试用例**：
1. `readContainedFile(abs, root, expectedRealRoot, {maxBytes: 64})` 对 100B 文件 → 返回前 64B + `truncated:true`（**同一 fd 上 `fh.read(buffer, 0, maxBytes+1)` 限读**，不 `fh.readFile` 整读）
2. ≤maxBytes 文件 → 完整内容 + `truncated:false`
3. 不传 maxBytes → 行为与现状逐字节一致（**F027 全部既有调用方测试零改动保持绿** = 回归锚）
4. maxBytes 路径下 nlink>1 拒 / realpath 越界抛——原防御全保留（防御不因新参数旁路）
**TDD → Commit** `feat(F028): readContainedFile 加 maxBytes 同 fd 限读——原语层资源上限 [黄仁勋]`

### Task 13: 文件 content（readContainedFile 复用 + 策略层 · r5 修订）

**Files:** Create `packages/api/src/project-tree/tree-content.ts` + test
**用例**：正常 .ts → content+mtime；denylist 路径 → null（404 语义，与隐藏同源判定）；**拒 ADS**（含 `:` 报 400）；>512KB（原语 maxBytes 开关）→ 截断+truncated；NUL 字节 → BINARY_FILE；越界 → WikiPathInvalidError 透传（只测分流不重测原语）
**TDD → Commit** `feat(F028): project-tree content——ADS 防御+复用原语 maxBytes [黄仁勋]`

### Task 14: routes/project-tree.ts + server 挂载

**Files:** Create `packages/api/src/routes/project-tree.ts` + test；Modify `packages/api/src/server.ts`
**用例**：roots/list/content 200 透传；越界 → 400；不存在 → 404；BINARY_FILE → 400。
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
| detached 子进程随主 API 重启失联 | 状态文件 pid+CreationDate 持久化；boot reconcile 重建视图；running 真相=端口探测+所有权实测 |
| CreationDate 误判（PID 复用）| spawn 后与 kill 预检用**同一 CIM 查询源**采集，同表示**精确相等**比较（±2s 容差方案被 r2 否决）；再叠 listener 后代链校验双保险 |
| spawn 类测试 flaky | 编排器/inventory 测试全 deps 注入零真 IO；真 spawn 只在 Task 10/16 人工集成步 |
| registry 并发写 | 复用 F024 proper-lockfile 原语 |
| preview API 实例收到控制请求自杀 | **D12 控制面单实例**：控制路由仅主 API 注册（WORKTREE_PREVIEW 门禁），preview 实例只读 + capabilities 报 control:false，UI 禁钮导主 UI |
| UI 路径零 dotenv 注入被 CLI 残留 `.env.development.local` 覆盖 | **不会**——Next.js 官方 Load Order 第 1 位 = `process.env`（"stopping once the variable is found"，nextjs.org/docs/app/guides/environment-variables 2026-03 版实查），子进程 env 注入恒压过 .env 文件 |
