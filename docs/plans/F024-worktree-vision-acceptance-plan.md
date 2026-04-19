# F024 Worktree 愿景验收基础设施 Implementation Plan

**Feature:** F024 — `docs/features/F024-worktree-vision-acceptance-infra.md`
**Goal:** 把愿景验收从 `dev` 主仓迁出，落成 `L1 worktree preview + L2 临时集成 worktree` 双层同源验收链路，做到单 feature 在 worktree 内完成愿景验收，多 feature 在一次性 staging worktree 完成协同验收。
**Acceptance Criteria:**
- AC-1.1: 同时启动 2 个 worktree，各自 curl 自己端口返回各自分支代码的响应，互不冲突
- AC-1.2: worktree A 创建的记录，worktree B 与 `dev` 都看不到
- AC-1.3: 启动命令 stdout 包含 `worktree <name> preview: localhost:<port>`
- AC-1.4: 在 worktree 内跑 acceptance-guardian，证据/截图/日志落在当前 worktree 的 `.agents/` 下
- AC-1.5: 单 feature 走完 L1 验收，`dev` 工作目录除代码外无增量污染
- AC-2.1: staging 脚本读取 manifest（feature + commit SHA + 愿景版本）并产出可运行集成 worktree
- AC-2.2: manifest 缺项立即报错退出，绝不创建环境
- AC-2.3: staging worktree 命名前缀 `staging/`，销毁后 `git worktree list` 与数据目录都无残留
- AC-2.4: 每份 L2 报告带 manifest 三元组，可追溯“验的是谁 / 哪个 commit / 哪版愿景”
- AC-M.1: F024 自己必须通过 L1 自验，产出 `worktree-report`
- AC-M.2: 选两条在途 feature（优先 F021 + F022）走一遍 L2 愿景验收
- AC-M.3: `shared-rules.md`、`acceptance-guardian/SKILL.md`、`merge-gate/SKILL.md` 按新规则同步完成
**Architecture:** API 侧补齐运行时目录配置，把 SQLite 保持在 worktree 自己的 `.runtime/`，把验收证据输出绑定到当前 worktree 的 `.agents/`。L1 由一个可测试的 `worktree-preview` 启动器分配端口并组装 env；L2 由一个 manifest 驱动的 staging worktree 脚本创建、验收、销毁，严格禁止常驻化。
**Tech Stack:** Node.js / TypeScript / Fastify / Next.js dev server / Git worktree / pnpm / node:test

**Not doing:**
- 不改 `.env`、MCP config、运行时启动配置
- 不引入长期常驻的 `staging` 分支或第二个共享环境
- 不把愿景定义从主仓 `.agents/vision/` 下放到各 worktree
- 不在本 feature 内做 Vision Dashboard UI

---

## Straight-Line Check

- **A → B**
  - A: 所有愿景验收都要推 `dev`，导致 worktree 只隔离“开发”，不隔离“验收”
  - B: 单 feature 在自身 worktree 内完成 preview + guardian，多 feature 在一次性 staging worktree 完成协同验收，`dev` 只做 merge 后 smoke
- **Terminal schema**
  - API 配置终态：`apiConfig` 显式暴露 `uploadsDir` / `runtimeEventsDir`
  - L1 启动终态：`scripts/worktree-preview.ts` + `.worktree-ports.json`
  - L2 启动终态：`scripts/worktree-staging.ts` + machine-readable manifest schema
  - 验收产物终态：`<worktree>/.agents/acceptance/worktree-report.md` / `integration-report.md`
  - 规则终态：`shared-rules.md`、`acceptance-guardian`、`merge-gate` 都以“同源原则 + manifest 三元组”为准
- **固定实现约束**
  - 端口注册表采用主仓中心化 `.worktree-ports.json`
  - `uploads` 和 `runtime-events` 走显式路径配置，不靠隐式 cwd 约定
  - L2 manifest 最小 schema 固化为：`stagingId`、`visionVersion`、`baseRef`、`features[{ featureId, commitSha }]`
  - **Preview banner 形态**（桂芬视觉约束 + 范德彪工程约束合体）：
    - TTY 环境：ASCII 边框 + 彩色 worktree 名称 + 多行对齐的 web/api 端口
    - 非 TTY 环境（CI/日志重定向）：自动降级为单行纯文本 `worktree <name> preview: web=<url> api=<url>`
    - banner 仍必须包含 `worktree <name> preview: localhost:<port>` 关键串，满足 AC-1.3 的机器可校验
  - **浏览器标签页辨识**：`buildPreviewEnv` 必须注入 `NEXT_PUBLIC_APP_TITLE_PREFIX="[<worktree-name>] "`，web 端消费该 env 在 `<title>` 前注入前缀

---

## Task 1: API 运行时目录参数化（覆盖 AC-1.2 / AC-1.4 的前置）

**Files:**
- Modify: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\config.ts`
- Modify: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\index.ts`
- Modify: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\server.ts`
- Modify: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\runtime\event-recorder.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\config.test.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\packages\api\src\runtime\event-recorder.test.ts`

**Step 1.1: 写失败测试**

Create `packages/api/src/config.test.ts`

```typescript
import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

test("F024 config exposes overridable uploadsDir/runtimeEventsDir", async () => {
  process.env.UPLOADS_DIR = "C:/tmp/f024/uploads"
  process.env.RUNTIME_EVENTS_DIR = "C:/tmp/f024/runtime-events"
  const { apiConfig } = await import("./config")

  assert.equal(apiConfig.uploadsDir, "C:/tmp/f024/uploads")
  assert.equal(apiConfig.runtimeEventsDir, "C:/tmp/f024/runtime-events")

  delete process.env.UPLOADS_DIR
  delete process.env.RUNTIME_EVENTS_DIR
})

test("F024 config defaults runtime paths under cwd", async () => {
  const { apiConfig } = await import("./config")
  assert.equal(apiConfig.uploadsDir, path.join(process.cwd(), ".runtime", "uploads"))
  assert.equal(apiConfig.runtimeEventsDir, path.join(process.cwd(), ".runtime", "runtime-events"))
})
```

Create `packages/api/src/runtime/event-recorder.test.ts`

```typescript
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("F024 event recorder writes into configured runtimeEventsDir", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f024-events-"))
  process.env.RECORD_EVENTS = "1"
  process.env.RUNTIME_EVENTS_DIR = tempDir

  const { createEventRecorder } = await import("./event-recorder")
  const recorder = createEventRecorder("codex")
  recorder.record({ ok: true })

  assert.ok(recorder.filePath?.startsWith(tempDir))
  assert.ok(fs.existsSync(recorder.filePath!))
})
```

**Step 1.2: 跑测试确认失败**

Run: `pnpm test -- --test-name-pattern="F024 config|F024 event recorder"`
Expected: FAIL，`apiConfig` 还没有 `uploadsDir/runtimeEventsDir`，`event-recorder` 也仍写 `docs/runtime-events`

**Step 1.3: 写最小实现**

Edit `packages/api/src/config.ts`

```typescript
export const apiConfig = {
  // existing fields...
  uploadsDir: process.env.UPLOADS_DIR ?? path.join(process.cwd(), ".runtime", "uploads"),
  runtimeEventsDir:
    process.env.RUNTIME_EVENTS_DIR ?? path.join(process.cwd(), ".runtime", "runtime-events"),
}
```

Edit `packages/api/src/index.ts`

```typescript
const app = await createApiServer({
  apiBaseUrl: apiConfig.apiBaseUrl,
  sqlitePath: apiConfig.sqlitePath,
  corsOrigin: apiConfig.corsOrigin,
  redisUrl: apiConfig.redisUrl,
  uploadsDir: apiConfig.uploadsDir,
})
```

Edit `packages/api/src/server.ts`

```typescript
export async function createApiServer(options: {
  apiBaseUrl: string
  sqlitePath: string
  corsOrigin: string
  redisUrl: string
  uploadsDir: string
}) {
  const uploadsDir = options.uploadsDir
  mkdirSync(uploadsDir, { recursive: true })
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  })
}
```

Edit `packages/api/src/runtime/event-recorder.ts`

```typescript
import { apiConfig } from "../config"

const dir = apiConfig.runtimeEventsDir
```

**Step 1.4: 跑测试确认通过**

Run: `pnpm test -- --test-name-pattern="F024 config|F024 event recorder"`
Expected: PASS

**Step 1.5: 跑 API 相关回归**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern="uploads|preview|config|event recorder"`
Expected: PASS

**Step 1.6: Commit**

```bash
git add packages/api/src/config.ts packages/api/src/index.ts packages/api/src/server.ts packages/api/src/runtime/event-recorder.ts packages/api/src/config.test.ts packages/api/src/runtime/event-recorder.test.ts
git commit -m "feat(F024): 参数化 uploads 与 runtime events 目录 [范德彪/Codex 🐾]"
```

---

## Task 2: L1 端口注册表 + preview 启动器（覆盖 AC-1.1 / AC-1.3）

**Files:**
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-port-registry.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-port-registry.test.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-preview.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-preview.test.ts`
- Modify: `C:\Users\-\Desktop\Multi-Agent\package.json`

**Step 2.1: 写失败测试**

Create `scripts/worktree-port-registry.test.ts`

```typescript
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { claimPorts, releasePorts } from "./worktree-port-registry"

test("F024 claimPorts allocates stable api/web ports per worktree", () => {
  const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")), ".worktree-ports.json")
  const first = claimPorts(registryPath, "feat/F024")
  const second = claimPorts(registryPath, "feat/F021")

  assert.equal(first.apiPort, 8800)
  assert.equal(first.webPort, 3100)
  assert.equal(second.apiPort, 8801)
  assert.equal(second.webPort, 3101)
})

test("F024 releasePorts removes claimed worktree entry", () => {
  const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f024-ports-")), ".worktree-ports.json")
  claimPorts(registryPath, "feat/F024")
  releasePorts(registryPath, "feat/F024")
  assert.equal(fs.readFileSync(registryPath, "utf8").includes("feat/F024"), false)
})
```

Create `scripts/worktree-preview.test.ts`

```typescript
import assert from "node:assert/strict"
import test from "node:test"

import { buildPreviewEnv, formatPreviewBanner } from "./worktree-preview"

test("F024 buildPreviewEnv points sqlite to .runtime and evidence to .agents", () => {
  const env = buildPreviewEnv({
    repoRoot: "C:/repo",
    worktreeName: "feat/F024",
    apiPort: 8800,
    webPort: 3100,
  })

  assert.equal(env.SQLITE_PATH, "C:/repo/.runtime/worktree-preview/data/multi-agent.sqlite")
  assert.equal(env.UPLOADS_DIR, "C:/repo/.agents/acceptance/uploads")
  assert.equal(env.RUNTIME_EVENTS_DIR, "C:/repo/.agents/acceptance/runtime-events")
})

test("F024 formatPreviewBanner prints the required preview line", () => {
  const text = formatPreviewBanner({ worktreeName: "feat/F024", webPort: 3100, apiPort: 8800 })
  assert.match(text, /worktree feat\\/F024 preview: localhost:3100/)
})
```

**Step 2.2: 跑测试确认失败**

Run: `pnpm test -- --test-name-pattern="F024 claimPorts|F024 buildPreviewEnv|F024 formatPreviewBanner"`
Expected: FAIL，脚本尚不存在

**Step 2.3: 写最小实现**

Create `scripts/worktree-port-registry.ts`

```typescript
export function claimPorts(registryPath: string, worktreeName: string) {
  // 读写 .worktree-ports.json
  // API 从 8800 起，Web 从 3100 起
}

export function releasePorts(registryPath: string, worktreeName: string) {
  // 删除 worktree 条目并写回
}
```

Create `scripts/worktree-preview.ts`

```typescript
export function buildPreviewEnv(input: {
  repoRoot: string
  worktreeName: string
  apiPort: number
  webPort: number
}) {
  return {
    API_PORT: String(input.apiPort),
    PORT: String(input.webPort),
    NEXT_PUBLIC_API_HTTP_URL: `http://localhost:${input.apiPort}`,
    NEXT_PUBLIC_API_WS_URL: `ws://localhost:${input.apiPort}`,
    SQLITE_PATH: `${input.repoRoot}/.runtime/worktree-preview/data/multi-agent.sqlite`,
    UPLOADS_DIR: `${input.repoRoot}/.agents/acceptance/uploads`,
    RUNTIME_EVENTS_DIR: `${input.repoRoot}/.agents/acceptance/runtime-events`,
  }
}

export function formatPreviewBanner(input: {
  worktreeName: string
  webPort: number
  apiPort: number
}) {
  return [
    `worktree ${input.worktreeName} preview: localhost:${input.webPort}`,
    `api: http://localhost:${input.apiPort}`,
  ].join("\n")
}
```

Add to `package.json`

```json
{
  "scripts": {
    "worktree:preview": "tsx scripts/worktree-preview.ts",
    "worktree:staging": "tsx scripts/worktree-staging.ts"
  }
}
```

**Step 2.4: 跑测试确认通过**

Run: `pnpm test -- --test-name-pattern="F024 claimPorts|F024 buildPreviewEnv|F024 formatPreviewBanner"`
Expected: PASS

**Step 2.5: 手动验证单 worktree 预览**

Run: `pnpm worktree:preview`
Expected:
- stdout 出现 `worktree <name> preview: localhost:<port>`
- API / Web 各自启动在分配端口
- 当前 worktree 生成 `.worktree-ports.json` 条目、`.runtime/worktree-preview/`、`.agents/acceptance/`

**Step 2.6: Commit**

```bash
git add scripts/worktree-port-registry.ts scripts/worktree-port-registry.test.ts scripts/worktree-preview.ts scripts/worktree-preview.test.ts package.json
git commit -m "feat(F024): 增加 worktree preview 启动器与端口注册表 [范德彪/Codex 🐾]"
```

---

## Task 3: 同源验收规则落地（覆盖 AC-1.4 / AC-1.5 / AC-M.3）

**Files:**
- Modify: `C:\Users\-\Desktop\Multi-Agent\.gitignore`
- Modify: `C:\Users\-\Desktop\Multi-Agent\multi-agent-skills\acceptance-guardian\SKILL.md`
- Modify: `C:\Users\-\Desktop\Multi-Agent\multi-agent-skills\merge-gate\SKILL.md`
- Modify: `C:\Users\-\Desktop\Multi-Agent\multi-agent-skills\refs\shared-rules.md`
- Modify: `C:\Users\-\Desktop\Multi-Agent\multi-agent-skills\worktree\SKILL.md`

**Step 3.1: 先写文档断言清单**

Run: `rg -n "同源|worktree-report|integration-report|manifest 三元组|worktree:preview" multi-agent-skills`
Expected: 现状缺少这些约束，至少 1 项找不到

**Step 3.2: 写最小实现**（严解共识 · 2026-04-19 小孙拍板）

严解前提：证据**不进 git 历史**，只留 worktree 本地；主仓 agent 经 FS 跨 worktree 读取。

Edit `.gitignore`（主仓）

```gitignore
.agents/acceptance/
```

Edit `multi-agent-skills/acceptance-guardian/SKILL.md`

```markdown
- Feature Mode 在 worktree 内执行时，报告必须写入当前 worktree 的 `.agents/acceptance/{feature-id}/{timestamp}/worktree-report.md`
- 如目标为 staging worktree，报告写入 `.agents/acceptance/{stagingId}/{timestamp}/integration-report.md`
- `.agents/acceptance/` 已在主仓 `.gitignore` — 证据不进 git，merge 后 dev 不含归档
- 主仓 agent 需读取其他 worktree 证据时：`git worktree list` → 按分支名匹配 feature-id → 拼 `{worktree-path}/.agents/acceptance/{feature-id}/`
- 不允许从 `dev` 首次证明 AC 成立；验收对象路径必须与待合入 worktree 同源
```

Edit `multi-agent-skills/merge-gate/SKILL.md`

```markdown
6. F024 之后新增硬门：
   - 单 feature merge 前必须存在 `{current-worktree}/.agents/acceptance/{feature-id}/*/worktree-report.md`
   - 多 feature 协同 merge 前必须存在 `{staging-worktree}/.agents/acceptance/{stagingId}/*/integration-report.md`
   - 报告内必须带 manifest 三元组（feature / commit / visionVersion）
   - 注意：报告不进 git（已被 `.gitignore`），merge-gate 校验走 FS 路径而非 git log
```

Edit `multi-agent-skills/refs/shared-rules.md`

```markdown
14. 验收环境必须和待合入对象同源
15. L2 集成验收必须绑定 manifest 三元组（featureId + commitSha + visionVersion）
16. 验收证据（截图/日志/报告）只留 worktree 本地 `.agents/acceptance/`，不进 git 历史；worktree 销毁即证据消失，需长期归档由人工显式操作
```

Edit `multi-agent-skills/worktree/SKILL.md`

```markdown
- 新 worktree 完成依赖安装后，先跑 `pnpm worktree:preview` 验证 preview 能启动
- 清理 worktree 时若存在 `.worktree-ports.json` 条目和 `.runtime/worktree-preview/` 残留，必须一并释放
- `.agents/acceptance/` 下的验收证据随 worktree 销毁而消失 — 销毁前如需保留，由人工手动复制到主仓外的归档位置
```

**Step 3.3: 验证文档改造完成**

Run: `pnpm check:docs`
Expected: PASS

Run: `rg -n "同源|worktree-report|integration-report|manifest 三元组|worktree:preview|\.agents/acceptance" multi-agent-skills`
Expected: 四个 SKILL.md 都能命中对应规则

Run: `rg -n "^\.agents/acceptance/" .gitignore`
Expected: 命中一行

**Step 3.4: Commit**

```bash
git add .gitignore multi-agent-skills/acceptance-guardian/SKILL.md multi-agent-skills/merge-gate/SKILL.md multi-agent-skills/refs/shared-rules.md multi-agent-skills/worktree/SKILL.md
git commit -m "feat(F024): 落地同源验收规则与技能文档（严解 · 证据不进 git）"
```

---

## Task 4: L2 staging manifest + 创建/销毁脚本（覆盖 AC-2.1 / AC-2.2 / AC-2.3 / AC-2.4）

**Files:**
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-staging.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\scripts\worktree-staging.test.ts`
- Create: `C:\Users\-\Desktop\Multi-Agent\docs\examples\worktree-staging-manifest.example.json`

**Step 4.1: 写失败测试**

Create `scripts/worktree-staging.test.ts`

```typescript
import assert from "node:assert/strict"
import test from "node:test"

import { parseStagingManifest, buildStagingBranchName } from "./worktree-staging"

test("F024 parseStagingManifest rejects manifest without visionVersion", () => {
  assert.throws(
    () => parseStagingManifest({ stagingId: "demo", baseRef: "dev", features: [{ featureId: "F021", commitSha: "abc" }] }),
    /visionVersion/,
  )
})

test("F024 buildStagingBranchName enforces staging prefix", () => {
  assert.equal(buildStagingBranchName("f021-f022"), "staging/f021-f022")
})
```

Create `docs/examples/worktree-staging-manifest.example.json`

```json
{
  "stagingId": "f021-f022-vision-check",
  "baseRef": "dev",
  "visionVersion": "2026-04-19",
  "features": [
    { "featureId": "F021", "commitSha": "aaaaaaaa" },
    { "featureId": "F022", "commitSha": "bbbbbbbb" }
  ]
}
```

**Step 4.2: 跑测试确认失败**

Run: `pnpm test -- --test-name-pattern="F024 parseStagingManifest|F024 buildStagingBranchName"`
Expected: FAIL，staging 脚本尚不存在

**Step 4.3: 写最小实现**

Create `scripts/worktree-staging.ts`

```typescript
export function parseStagingManifest(input: unknown) {
  // 校验 stagingId / baseRef / visionVersion / features[].featureId / features[].commitSha
}

export function buildStagingBranchName(stagingId: string) {
  return `staging/${stagingId}`
}

// CLI mode:
// create -> git worktree add ../multi-agent-staging-<id> -b staging/<id> <baseRef>
// destroy -> git worktree remove + git branch -D + releasePorts + 删除临时数据目录
```

**Step 4.4: 跑测试确认通过**

Run: `pnpm test -- --test-name-pattern="F024 parseStagingManifest|F024 buildStagingBranchName"`
Expected: PASS

**Step 4.5: 手动验证 create / destroy**

Run: `pnpm worktree:staging create docs/examples/worktree-staging-manifest.example.json`
Expected:
- 生成 `staging/<id>` 分支和对应 worktree
- stdout 打印 preview 地址与 manifest 三元组
- `.agents/acceptance/integration-report.md` 模板位已生成

Run: `pnpm worktree:staging destroy docs/examples/worktree-staging-manifest.example.json`
Expected:
- `git worktree list` 不再含 `staging/<id>`
- `.runtime/staging/<id>` 与 `.agents/acceptance/<id>` 无残留

**Step 4.6: Commit**

```bash
git add scripts/worktree-staging.ts scripts/worktree-staging.test.ts docs/examples/worktree-staging-manifest.example.json
git commit -m "feat(F024): 增加 manifest 驱动的 staging worktree 脚本 [范德彪/Codex 🐾]"
```

---

## Task 5: L1 dogfooding 与污染回归验证（覆盖 AC-1.1 / AC-1.2 / AC-1.5 / AC-M.1）

**Files:**
- Modify: `C:\Users\-\Desktop\Multi-Agent\docs\features\F024-worktree-vision-acceptance-infra.md`
- Create: `C:\Users\-\Desktop\Multi-Agent\.agents\acceptance\worktree-report.md`（在 F024 自己的 worktree 内）

**Step 5.1: 开两个 worktree 并启动 preview**

Run:

```bash
git worktree add ../multi-agent-f024-a -b feat/F024-a
git worktree add ../multi-agent-f024-b -b feat/F024-b
```

Then in each worktree:

```bash
pnpm install
pnpm mount-skills
pnpm worktree:preview
```

Expected:
- 两个 worktree 各拿到不同 `api/web` 端口
- banner 都包含 `worktree <name> preview: localhost:<port>`

**Step 5.2: 验证端口隔离**

Run: `curl http://localhost:<web_port_a>` and `curl http://localhost:<web_port_b>`
Expected: 两边返回当前各自 worktree 的响应，互不串线

**Step 5.3: 验证数据隔离**

在 worktree A 创建一条新线程/消息，再在 worktree B 与主仓 `dev` 查询同一路径。
Expected: 只有 A 可见，B 与 `dev` 不可见

**Step 5.4: 跑 acceptance-guardian 自验**

在 F024 worktree 内执行 guardian 流程，输出：

```markdown
# .agents/acceptance/worktree-report.md
- feature: F024
- environment: feat/F024
- visionVersion: 2026-04-19
- evidence:
  - uploads: .agents/acceptance/uploads
  - runtime-events: .agents/acceptance/runtime-events
```

Expected: report 存在且证据目录都在当前 worktree `.agents/`

**Step 5.5: 验证 `dev` 零污染**

Run from main repo: `git status --short`
Expected: 不因 preview/guardian 产物新增主仓 `.runtime/`、`docs/runtime-events/`、`uploads/` 污染

**Step 5.6: 勾选 F024 的 L1 / Meta AC**

Edit `docs/features/F024-worktree-vision-acceptance-infra.md`
- `[x] AC-1.1`
- `[x] AC-1.2`
- `[x] AC-1.3`
- `[x] AC-1.4`
- `[x] AC-1.5`
- `[x] AC-M.1`
- Timeline 追加 L1 dogfooding 记录

**Step 5.7: Commit**

Only the feature doc (with L1 AC ticked) enters git. The worktree-report itself stays
under `.agents/acceptance/` (which is gitignored) so dev stays clean per AC-1.5.

```bash
git add docs/features/F024-worktree-vision-acceptance-infra.md
git commit -m "test(F024): 完成 L1 dogfooding 与 worktree-report [范德彪/Codex 🐾]"
```

---

## Task 6: L2 实战演示（覆盖 AC-2.1 / AC-2.2 / AC-2.3 / AC-2.4 / AC-M.2）

**Files:**
- Modify: `C:\Users\-\Desktop\Multi-Agent\docs\features\F024-worktree-vision-acceptance-infra.md`
- Create: `C:\Users\-\Desktop\Multi-Agent\.agents\acceptance\integration-report.md`（在 staging worktree 内）

**Step 6.1: 生成 F021 + F022 staging manifest**

Create manifest:

```json
{
  "stagingId": "f021-f022-dogfood",
  "baseRef": "dev",
  "visionVersion": "2026-04-19",
  "features": [
    { "featureId": "F021", "commitSha": "<real-sha-1>" },
    { "featureId": "F022", "commitSha": "<real-sha-2>" }
  ]
}
```

**Step 6.2: 创建 staging worktree**

Run: `pnpm worktree:staging create <manifest-path>`
Expected: `staging/f021-f022-dogfood` 出现，preview 能启动

**Step 6.3: 跑 integration acceptance**

在 staging worktree 内运行 guardian，生成 `.agents/acceptance/integration-report.md`

Report 至少包含：

```markdown
- stagingId: f021-f022-dogfood
- visionVersion: 2026-04-19
- features:
  - F021 @ <sha1>
  - F022 @ <sha2>
```

**Step 6.4: 验证 destroy**

Run: `pnpm worktree:staging destroy <manifest-path>`
Expected: `git worktree list` 无该 staging worktree，相关端口和数据目录释放

**Step 6.5: 勾选 F024 的 L2 / Meta AC**

Edit `docs/features/F024-worktree-vision-acceptance-infra.md`
- `[x] AC-2.1`
- `[x] AC-2.2`
- `[x] AC-2.3`
- `[x] AC-2.4`
- `[x] AC-M.2`
- Timeline 追加 staging dogfooding 记录

**Step 6.6: Commit**

Only the feature doc enters git. The integration-report stays inside the staging
worktree's `.agents/acceptance/` (gitignored) so dev stays clean per AC-1.5.

```bash
git add docs/features/F024-worktree-vision-acceptance-infra.md
git commit -m "test(F024): 完成 L2 staging dogfooding 与 integration-report [范德彪/Codex 🐾]"
```

---

## Final Gate

**全量验证命令**

Run:

```bash
pnpm test
pnpm --filter @multi-agent/api build
pnpm check:docs
git worktree list
git status --short
```

Expected:
- `pnpm test` 绿
- API build 绿
- docs 校验绿
- worktree 列表里只剩当前应该存在的 worktree
- 主仓没有 runtime / uploads / docs/runtime-events 污染

**交付证据**

- `docs/features/F024-worktree-vision-acceptance-infra.md` AC 全打勾
- `docs/discussions/2026-04-19-worktree-vision-acceptance.md` 作为收敛来源
- `.agents/acceptance/worktree-report.md`
- `.agents/acceptance/integration-report.md`
- `.worktree-ports.json`（执行期存在，销毁后应只保留仍活着的 worktree）

## 下一步

计划写完 → 进入 `worktree`（创建 F024 隔离开发环境）→ `tdd`（从 Task 1 开始做 Red → Green → Refactor）。
