# F023 三家 MCP 挂载统一 + 弃 CALLBACK_API_PROMPT Implementation Plan

**Feature:** F023 — `docs/features/F023-mcp-unified-mounting.md`
**Goal:** 三家 CLI（Claude / Codex / Gemini）统一通过项目级官方配置挂载 `multi_agent_room` MCP server；删除 runtime 临时 `--mcp-config` + `mkdtemp` 路径和 `CALLBACK_API_PROMPT` 指令。
**Acceptance Criteria (Phase A — Task 1-6 已交付):**
- AC1: Claude runtime 工具列表含 `mcp__multi_agent_room__take_screenshot` 等 MCP 工具
- AC2: Codex runtime 能直接调用 MCP 工具（通过 `.codex/config.toml`）
- AC3: Gemini runtime 能直接调用 MCP 工具（通过 `.gemini/settings.json`）
- AC4: `packages/api/dist/mcp/server.js` 由 build 流程保证与 `src/mcp/server.ts` 同步
- AC5: `claude-runtime.ts` 中 `mkdtemp` / `writeFileSync(mcp-config.json)` / `--mcp-config` 全删
- AC6: 全项目源码（`packages/api/src/**`）grep `CALLBACK_API_PROMPT` 和 `Callback API` 零匹配
- AC7: `agent-prompts.test.ts` 中 `Callback API` 断言删除或重写，pnpm test 全绿
- AC8: 三家联动实际跑一次——Codex/Gemini 通过 MCP 调 `post_message` 或 `take_screenshot`，前端看到结果

**Acceptance Criteria (Phase B — 2026-04-20 扩 scope，Task 7-11):**
- AC9（根因 A 修复）: runtime spawn CLI 时 cwd 显式传当前 invocation 的 `projectRoot`；`AgentRunInput` 补 cwd 字段；单元测试断言 spawn 接收到正确 cwd
- AC10（根因 B Spike + 修复）: Gemini 在 worktree 启动后，MCP 工具列表包含 `mcp__multi_agent_room__*`；产出 Spike 报告 + 针对性修复 + 回归测试
- AC11（根因 C Spike + 修复）: Codex 在 worktree 启动后，MCP 工具列表包含 `mcp__multi_agent_room__*`；产出 Spike 报告 + 针对性修复 + 回归测试
- AC12（worktree 同源验证）: worktree 里加 stub tool → 该 worktree CLI 能列出 stub tool，主仓 CLI 不出现
- AC13（Phase D 防御）: runtime room 启动时清理 `~/.claude.json.projects[projectRoot].mcpServers.multi_agent_room`；单元测试覆盖 stale/empty/other-server 三种场景

**Architecture (Phase A):** 照搬 clowder-ai 验证过的模式——项目根放三份同构的官方 MCP 配置文件，全部指向 `packages/api/dist/mcp/server.js`（现为相对路径，hotfix 9fd0582 后）。动态 token 靠进程继承链（base-runtime spawn 时 `env: {MULTI_AGENT_*}` 已传）。Gemini 配置写 `env: {VAR: "${VAR}"}` 触发 CLI 侧展开，Claude/Codex 裸继承即可。

**Architecture (Phase B 追加，2026-04-20):** 相对路径方向对但不够——runtime spawn CLI 时 cwd 必须显式传当前 invocation 的 projectRoot（`AgentRunInput.cwd`），相对路径才会被解析到该 worktree 的 dist。Gemini/Codex 挂不上的根因未知，先 Spike 再补修复。Phase D 清理逻辑作为前瞻防御加入 room 启动链。

**Tech Stack:** Node.js / TypeScript / 三家官方 CLI 配置规范 / pnpm 工作流

**Not doing:**
- 不动 `getCallbackIdentity()` 读 env 的逻辑（已就绪）
- 不动 `packages/api/src/mcp/server.ts` 里的工具注册（F018/F019 已注册足够）
- 不做 monorepo 拆 `packages/mcp-server` 子包（单包足够）
- **不做 ACP resolver**（Phase B 调研确认 Gemini 走纯 CLI spawn，`gemini-runtime.ts:88-116`，不适用 clowder-ai F145 Phase C 的 `resolveAcpMcpServers`）
- **不主动清理 `~/.claude.json` global mcpServers**（clowder-ai F145 KD：global 优先级低于 `.mcp.json`，不遮蔽；且可能服务其他项目）

---

## Straight-Line Check

- **A → B**：A = "Claude 的 MCP 永远 spawn 失败 + Codex/Gemini 根本没 MCP + /tmp 堆积 2222 个 mcp-config"；B = "三家都能原生调 `multi_agent_room` MCP 工具 + 0 个临时目录 + 0 行 `node -e fetch` 指令"
- **终态 schema**：
  - 三份配置文件（`.mcp.json` / `.codex/config.toml` / `.gemini/settings.json`）— 终态保留
  - `dist/mcp/server.js` — 终态保留
  - `claude-runtime.ts:90-116` 删掉 — 终态消失
  - `CALLBACK_API_PROMPT` 常量删掉 — 终态消失
  - `agent-prompts.test.ts` 两个断言改写 — 终态保留（换成 MCP 断言）
- 每步的产物在终态保留或显式删除，无绕路

---

## Task 1: 修 `dev:api` 确保 `dist/mcp/server.js` 新鲜（AC4）

**Files:**
- Modify: `C:\Users\-\Desktop\Multi-Agent\package.json:11` — `dev:api` 脚本
- Verify: `packages/api/dist/mcp/server.js` 存在（当前已存在，来自过去一次 build）

**Step 1.1: 写 script-level 校验测试**

Create: `scripts/__tests__/mcp-dist-built.test.ts`

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"

describe("F023 MCP dist build", () => {
  it("packages/api/dist/mcp/server.js must exist after build", () => {
    const distPath = path.resolve(__dirname, "../../packages/api/dist/mcp/server.js")
    assert.ok(existsSync(distPath), `MCP server dist artifact missing: ${distPath}`)
  })
})
```

**Step 1.2: 跑测试**

Run: `pnpm test -- --test-name-pattern="F023 MCP dist build"`
Expected: PASS（当前 dist 已存在，验证测试本身可用）

**Step 1.3: 修改 `dev:api` 脚本加一步 api build**

当前：
```
"dev:api": "bash scripts/mount-skills.sh --prune && tsc -p packages/shared/tsconfig.json && tsx watch packages/api/src/index.ts"
```

改为：
```
"dev:api": "bash scripts/mount-skills.sh --prune && tsc -p packages/shared/tsconfig.json && tsc -p packages/api/tsconfig.json && tsx watch packages/api/src/index.ts"
```

**Step 1.4: 验证 `pnpm build` 正确产出**

Run: `pnpm --filter @multi-agent/api build && ls packages/api/dist/mcp/server.js`
Expected: 文件存在，大小 > 1KB

**Step 1.5: Commit**

```bash
git add package.json scripts/__tests__/mcp-dist-built.test.ts
git commit -m "feat(F023): dev:api 加 api dist build 保证 mcp/server.js 新鲜 [黄仁勋/Opus-47 🐾]"
```

---

## Task 2: 写项目根三份官方 MCP 配置文件（AC1/AC2/AC3）

**Files:**
- Create: `C:\Users\-\Desktop\Multi-Agent\.mcp.json`
- Create: `C:\Users\-\Desktop\Multi-Agent\.codex\config.toml`
- Create: `C:\Users\-\Desktop\Multi-Agent\.gemini\settings.json`
- Test: `scripts/__tests__/mcp-configs-present.test.ts`

**Step 2.1: 写三家配置存在性校验测试**

Create: `scripts/__tests__/mcp-configs-present.test.ts`

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "../..")
const MCP_SERVER_NAME = "multi_agent_room"

describe("F023 三家 MCP 配置文件", () => {
  it(".mcp.json exists with multi_agent_room server", () => {
    const p = path.join(root, ".mcp.json")
    assert.ok(existsSync(p), ".mcp.json missing")
    const cfg = JSON.parse(readFileSync(p, "utf-8"))
    assert.ok(cfg.mcpServers?.[MCP_SERVER_NAME], `.mcp.json missing ${MCP_SERVER_NAME}`)
  })

  it(".codex/config.toml exists and references multi_agent_room", () => {
    const p = path.join(root, ".codex/config.toml")
    assert.ok(existsSync(p), ".codex/config.toml missing")
    const content = readFileSync(p, "utf-8")
    assert.match(content, new RegExp(`\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`))
  })

  it(".gemini/settings.json exists with multi_agent_room + env expansion", () => {
    const p = path.join(root, ".gemini/settings.json")
    assert.ok(existsSync(p), ".gemini/settings.json missing")
    const cfg = JSON.parse(readFileSync(p, "utf-8"))
    const entry = cfg.mcpServers?.[MCP_SERVER_NAME]
    assert.ok(entry, `.gemini/settings.json missing ${MCP_SERVER_NAME}`)
    assert.equal(entry.env?.MULTI_AGENT_CALLBACK_TOKEN, "${MULTI_AGENT_CALLBACK_TOKEN}")
  })
})
```

**Step 2.2: 跑测试确认失败**

Run: `pnpm test -- --test-name-pattern="F023 三家 MCP 配置文件"`
Expected: FAIL（三份配置都不存在）

**Step 2.3: 创建 `.mcp.json`**

Create: `.mcp.json`

```json
{
  "mcpServers": {
    "multi_agent_room": {
      "command": "node",
      "args": [
        "C:\\Users\\-\\Desktop\\Multi-Agent\\packages\\api\\dist\\mcp\\server.js"
      ]
    }
  }
}
```

**Step 2.4: 创建 `.codex/config.toml`**

Create: `.codex/config.toml`

```toml
[mcp_servers.multi_agent_room]
command = "node"
args = [ "C:\\Users\\-\\Desktop\\Multi-Agent\\packages\\api\\dist\\mcp\\server.js" ]
enabled = true
```

**Step 2.5: 创建 `.gemini/settings.json`**

Create: `.gemini/settings.json`

```json
{
  "mcpServers": {
    "multi_agent_room": {
      "command": "node",
      "args": [
        "C:\\Users\\-\\Desktop\\Multi-Agent\\packages\\api\\dist\\mcp\\server.js"
      ],
      "env": {
        "MULTI_AGENT_API_URL": "${MULTI_AGENT_API_URL}",
        "MULTI_AGENT_INVOCATION_ID": "${MULTI_AGENT_INVOCATION_ID}",
        "MULTI_AGENT_CALLBACK_TOKEN": "${MULTI_AGENT_CALLBACK_TOKEN}"
      }
    }
  }
}
```

**Step 2.6: 跑测试确认通过**

Run: `pnpm test -- --test-name-pattern="F023 三家 MCP 配置文件"`
Expected: PASS（三项全绿）

**Step 2.7: Commit**

```bash
git add .mcp.json .codex/config.toml .gemini/settings.json scripts/__tests__/mcp-configs-present.test.ts
git commit -m "feat(F023): 项目根写三家官方 MCP 配置文件（claude/codex/gemini）[黄仁勋/Opus-47 🐾]"
```

---

## Task 3: 删 `claude-runtime.ts` 临时 `--mcp-config` 逻辑（AC5）

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts:1-3,90-116,135` — 删 imports + mcp 临时配置整块 + cleanup 字段
- Test: `packages/api/src/runtime/claude-runtime.test.ts`（新建，验证 buildCommand 不再含 `--mcp-config`）

**Step 3.1: 写失败测试**

Create: `packages/api/src/runtime/claude-runtime.test.ts`

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ClaudeRuntime } from "./claude-runtime"

describe("F023 ClaudeRuntime buildCommand", () => {
  it("must NOT inject --mcp-config (project-level .mcp.json takes over)", () => {
    const runtime = new ClaudeRuntime()
    const cmd = (runtime as unknown as {
      buildCommand: (i: { prompt: string; env?: Record<string, string> }) => { args: string[]; cleanup?: unknown }
    }).buildCommand({
      prompt: "hi",
      env: {
        MULTI_AGENT_API_URL: "http://localhost:8787",
        MULTI_AGENT_INVOCATION_ID: "inv_test",
        MULTI_AGENT_CALLBACK_TOKEN: "tok_test"
      }
    })
    assert.ok(!cmd.args.includes("--mcp-config"), "--mcp-config must be removed")
    assert.equal(cmd.cleanup, undefined, "cleanup must be undefined (no tmp dir to clean)")
  })
})
```

**Step 3.2: 跑测试确认失败**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern="F023 ClaudeRuntime"`
Expected: FAIL（当前 args 含 `--mcp-config`）

**Step 3.3: 删 claude-runtime.ts 相关代码**

Edit `packages/api/src/runtime/claude-runtime.ts`:

```typescript
// 删第 1 行 imports 里的 mkdtempSync, writeFileSync
import { existsSync } from "node:fs";
// 删第 2 行 整行（不再用 tmpdir）
import path from "node:path";
```

删第 90-116 行整块（从 `const mcpServerPath = path.join...` 到 `args.push("--mcp-config", JSON.stringify(mcpConfigObj));`）。

删第 135 行 `cleanup,`（return 里不再有 cleanup）。

删 `let cleanup: (() => void) | undefined;` 声明行。

**Step 3.4: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern="F023 ClaudeRuntime"`
Expected: PASS

**Step 3.5: 跑全量 typecheck**

Run: `pnpm --filter @multi-agent/api typecheck`
Expected: 无错误

**Step 3.6: Commit**

```bash
git add packages/api/src/runtime/claude-runtime.ts packages/api/src/runtime/claude-runtime.test.ts
git commit -m "feat(F023): 删 claude-runtime.ts --mcp-config/mkdtemp 整块逻辑 [黄仁勋/Opus-47 🐾]"
```

---

## Task 4: 删 `CALLBACK_API_PROMPT` 常量 + 两处拼接 + 测试断言（AC6/AC7）

**Files:**
- Modify: `packages/api/src/runtime/agent-prompts.ts:93-119` — 删整个 CALLBACK_API_PROMPT
- Modify: `packages/api/src/runtime/agent-prompts.ts:261-262` — codex/gemini 去掉拼接
- Modify: `packages/api/src/runtime/agent-prompts.test.ts:17-25` — 改写两个 Callback API 断言
- Modify: `packages/api/src/orchestrator/context-assembler.ts:16` — 删过时注释

**Step 4.1: 写新的正向测试（MCP 工具可见性代替 Callback API 断言）**

Edit `packages/api/src/runtime/agent-prompts.test.ts`（替换第 17-25 行两个 `Callback API` 测试）：

```typescript
test("AGENT_SYSTEM_PROMPTS.codex does not include legacy Callback API section", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.codex
  assert.ok(!prompt.includes("Callback API"), "Codex prompt should not embed legacy Callback API curl guide")
  assert.ok(!prompt.includes("node -e"), "Codex prompt should not teach manual node -e fetch")
})

test("AGENT_SYSTEM_PROMPTS.gemini does not include legacy Callback API section", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.gemini
  assert.ok(!prompt.includes("Callback API"), "Gemini prompt should not embed legacy Callback API curl guide")
  assert.ok(!prompt.includes("node -e"), "Gemini prompt should not teach manual node -e fetch")
})
```

**Step 4.2: 跑测试确认失败**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern="AGENT_SYSTEM_PROMPTS"`
Expected: FAIL（当前两家仍含 Callback API）

**Step 4.3: 删 `CALLBACK_API_PROMPT` 常量**

删 `packages/api/src/runtime/agent-prompts.ts:93-119` 整块（从 `const CALLBACK_API_PROMPT = \`` 到 `\`.trim();`）。

**Step 4.4: 去掉 codex/gemini 拼接**

Edit `packages/api/src/runtime/agent-prompts.ts:261-262`：

当前：
```typescript
  codex: [buildBasePrompt("codex"), CALLBACK_API_PROMPT].join("\n\n"),
  gemini: [buildBasePrompt("gemini"), CALLBACK_API_PROMPT].join("\n\n")
```

改为：
```typescript
  codex: buildBasePrompt("codex"),
  gemini: buildBasePrompt("gemini")
```

**Step 4.5: 清 context-assembler.ts 过时注释**

Edit `packages/api/src/orchestrator/context-assembler.ts:16`（删那行 "CALLBACK_API_PROMPT is already included" 注释）。

**Step 4.6: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test -- --test-name-pattern="AGENT_SYSTEM_PROMPTS"`
Expected: PASS

**Step 4.7: 跑全量 test**

Run: `pnpm test`
Expected: 全绿

**Step 4.8: AC6 grep 验证**

Run: `rg "CALLBACK_API_PROMPT|Callback API" packages/api/src/`
Expected: 零匹配

**Step 4.9: Commit**

```bash
git add packages/api/src/runtime/agent-prompts.ts packages/api/src/runtime/agent-prompts.test.ts packages/api/src/orchestrator/context-assembler.ts
git commit -m "feat(F023): 删 CALLBACK_API_PROMPT + 两处拼接 + 测试断言改写 [黄仁勋/Opus-47 🐾]"
```

---

## Task 5: 清 `/tmp/multi-agent-mcp-*` 历史残骸

**Files:** 只清 `/tmp`，不动代码

**Step 5.1: 确认数量**

Run: `ls -1d /tmp/multi-agent-mcp-* 2>/dev/null | wc -l`
Expected: 上百个（非零）

**Step 5.2: 一次性清理**

Run: `rm -rf /tmp/multi-agent-mcp-*`
注意：Iron Law #1 说"禁止 rm SQLite/Redis/持久化文件"——`/tmp/multi-agent-mcp-*` 是 runtime 无用残骸，不是数据。此操作小孙已在 feature doc 里明确要求。

**Step 5.3: 验证 0 残骸**

Run: `ls -1d /tmp/multi-agent-mcp-* 2>/dev/null | wc -l`
Expected: `0`

**Step 5.4: 无 commit**（不涉及仓库文件）

---

## Task 6: 端到端三家联动验证（AC8）

**Files:** 无代码修改，仅运行验证

**Step 6.1: 重启 API 服务**

Run: `pnpm dev:api`（在独立终端）
Expected: 启动无报错，端口 `8787` listen

**Step 6.2: 前端启 room（通过 UI 或 API）**

让小孙在前端新建一个 room，分别给 Claude/Codex/Gemini 发一条"请调用 MCP 工具 `take_screenshot` 截一张当前屏幕截图"。

**Step 6.3: 观察三家的响应**

Expected：
- Claude 工具列表出现 `mcp__multi_agent_room__take_screenshot`，并能调用成功
- Codex 能直接 `mcp__multi_agent_room__take_screenshot`（不再出现 `node -e "const b=process.env..."` 手工 curl）
- Gemini 能直接 `mcp__multi_agent_room__take_screenshot`

**Step 6.4: 验证临时目录不再增长**

Run（启动 room 后）: `ls -1d /tmp/multi-agent-mcp-* 2>/dev/null | wc -l`
Expected: `0`（仍为 0）

**Step 6.5: 写验收记录到 feature doc**

在 `docs/features/F023-mcp-unified-mounting.md` 的 Timeline 追加：
```markdown
| 2026-04-19 | AC1-AC8 全部通过（证据：三家截图工具调用成功 / tmp/multi-agent-mcp-* 为 0 / pnpm test 全绿） |
```

**Step 6.6: Commit**

```bash
git add docs/features/F023-mcp-unified-mounting.md
git commit -m "docs(F023): 三家 MCP 挂载统一验收通过 [黄仁勋/Opus-47 🐾]"
```

---

---

# Phase B — 2026-04-20 扩 scope（A 方案：聚焦根因 + Spike）

> 前置：Phase A Task 1-6 已完成 6 个 commits（含 9fd0582 相对路径 hotfix + b5179f3 Known Bug 记录）。Phase B 在同一 F023 worktree 继续叠加。

## Task 7: 修根因 A — runtime spawn 显式传 projectRoot 作 cwd（AC9）

**Files:**
- Modify: `packages/api/src/runtime/types.ts`（或 base-runtime 所在类型文件）— `AgentRunInput` 的 cwd 字段改必填
- Modify: `packages/api/src/orchestrator/cli-orchestrator.ts:119-134` — 构建 `AgentRunInput` 时赋值 cwd
- Test: `packages/api/src/runtime/base-runtime.test.ts` 或新建 — 断言 spawn 接收到正确 cwd

**Step 7.1: 写失败测试 — AgentRunInput 带 cwd，spawn 能拿到**

Create / extend test：
- 构造 `AgentRunInput` 传 `cwd: '/tmp/fake-worktree'`
- mock `spawn`，断言第 3 个参数 `.cwd === '/tmp/fake-worktree'`
- 同时断言：不传 cwd 时 type error（TS 层）或运行时 assert 失败（运行时层）

**Step 7.2: 跑测试确认 FAIL**

Expected: 当前 cli-orchestrator 没传 cwd → spawn 收到 undefined，测试红

**Step 7.3: 类型改硬 — AgentRunInput.cwd: string（必填）**

Edit 类型文件。若有多处构造 AgentRunInput，全部会 TS 报错，逐个补。

**Step 7.4: cli-orchestrator 赋值 projectRoot**

`projectRoot` 来源策略（两选一，挑简单的）：
- [a] 从 invocation context / room context 读 — 若已有字段则直接用
- [b] 用 `process.cwd()`（`dev:api` 启动时的主仓根）

> 注：Phase B 当前仅解决"runtime 有 cwd 可传"这一层。worktree 场景下 projectRoot = worktree 根的问题归 F024 基础设施负责（F024 会在 preview 启动时以 worktree cwd 拉 dev:api，此时 `process.cwd()` 自然 = worktree 根）。F023 不承担 F024 的职责。

**Step 7.5: 跑测试确认 PASS + typecheck**

Run: `pnpm --filter @multi-agent/api test` + `pnpm --filter @multi-agent/api typecheck`
Expected: 全绿

**Step 7.6: Commit**

```
feat(F023): runtime spawn 显式传 projectRoot 作 cwd（根因 A 修复，AC9）[黄仁勋/Opus-47 🐾]
```

---

## Task 8: Spike 根因 B — Gemini MCP 挂不上（AC10 先产 Spike 报告）

**Files:** 无代码修改，仅实测 + 调研文档

**Step 8.1: 实跑桂芬拿日志**

在 F023 worktree 或 F024 preview 启动一轮 Gemini invocation。收集：
- Gemini CLI stderr（启动报错 / MCP 挂载日志）
- spawn 时实际传入的 cwd / env / args
- `.gemini/settings.json` 的解析结果（在 CLI 视角）

**Step 8.2: 对照假设定位根因**

候选检查清单：
- [ ] env 插值 `${VAR}` 是否被 Gemini CLI 展开？（对比实际 env 值和 CLI 读到的值）
- [ ] Gemini CLI 实际读的 settings.json 路径 — 项目级（`<cwd>/.gemini/settings.json`）还是用户级（`~/.gemini/settings.json`）？
- [ ] cwd 对不对？（Task 7 修完后复核）
- [ ] Gemini CLI 版本（`gemini --version`）是否支持 `mcpServers` 配置？

**Step 8.3: 写 Spike 报告**

Create: `docs/discussions/F023-phase-b-gemini-spike.md`
- 实验步骤 + 观察到的日志原文
- 根因判定（明确是哪一条或哪几条）
- 修复方案草案

**Step 8.4: Commit**

```
docs(F023): Gemini MCP 根因 B Spike 报告（AC10 前置）[黄仁勋/Opus-47 🐾]
```

---

## Task 9: 根因 B 修复（AC10）

**Files:** 依 Spike 结论决定——可能动 `.gemini/settings.json` / `gemini-runtime.ts` / runtime env 传递逻辑。

**Step 9.1-9.N:** 依 Task 8 结论展开 TDD（Red → Green → Refactor），每个 step 含测试。

**Step 9.last: Commit**

```
feat(F023): Gemini MCP 挂载修复（根因 B，AC10）[黄仁勋/Opus-47 🐾]
```

---

## Task 10: Spike 根因 C — Codex MCP 挂不上 + 修复（AC11）

结构同 Task 8 + 9。合并为单 task 因 Codex 问题域大概率和 Gemini 同构（cwd / 项目级配置位置 / CLI 版本）。

**Step 10.1: 实跑德彪拿日志**
**Step 10.2: 对照假设定位根因**
**Step 10.3: 写 Spike 报告**（`docs/discussions/F023-phase-b-codex-spike.md`）
**Step 10.4-N: TDD 修复**
**Step 10.last: Commit** — `feat(F023): Codex MCP 挂载修复（根因 C，AC11）[黄仁勋/Opus-47 🐾]`

---

## Task 11: Phase D 防御 — 清理 `~/.claude.json` per-project stale override（AC13）

**Files:**
- Create: `packages/api/src/runtime/claude-overrides-cleaner.ts` — 导出 `cleanStaleClaudeProjectOverrides(claudeConfigPath, projectRoot, serverNames)`
- Modify: room / invocation 启动链里合适的位置（例：writeMcpConfigs 之后）调用 cleaner
- Test: `packages/api/src/runtime/claude-overrides-cleaner.test.ts`

**Step 11.1: 写失败测试**

三场景：
- stale entry → 删除，文件 write-back
- 无 `projects[projectRoot]` 或 `.mcpServers` 为空 → no-op（不 crash、不 write）
- `mcpServers` 里有其他非 `multi_agent_room` server（如用户手动加的 pencil）→ 保留不动

**Step 11.2: FAIL → 实现 → PASS**

参考 clowder-ai `packages/api/src/config/capabilities/mcp-config-adapters.ts:270-306` 的 `cleanStaleClaudeProjectOverrides`（纯函数 + write-back，14 行核心逻辑）。只清 `projects[projectRoot].mcpServers[serverName]`，**不动 global `mcpServers`**。

**Step 11.3: 接入 room 启动链**

在 Claude runtime 启动前（或 writeMcpConfigs 之后）调用 `cleanStaleClaudeProjectOverrides(os.homedir() + '/.claude.json', projectRoot, ['multi_agent_room'])`。失败不抛（best-effort 防御，不阻塞 room 启动）。

**Step 11.4: Commit**

```
feat(F023): Phase D 防御 — 清理 ~/.claude.json per-project stale override（AC13）[黄仁勋/Opus-47 🐾]
```

---

## Task 12: Phase B 端到端验收（AC10/AC11/AC12 实跑确认）

**Files:** 无代码修改

**Step 12.1: worktree 同源 probe（AC12）**

在 F023 worktree 的 `packages/api/src/mcp/server.ts` 注册一个 stub tool `_f023_probe`（返回字符串 `"f023-phase-b-alive"`）。`pnpm build` worktree。

**Step 12.2: F024 preview 启 worktree 版 API + 三家**

Expected:
- worktree 的三家 CLI 工具列表都有 `mcp__multi_agent_room___f023_probe`
- 调用返回 `"f023-phase-b-alive"`
- 主仓（另起的 dev:api）CLI 工具列表**不出现** `_f023_probe`

**Step 12.3: 删 stub，complete Timeline**

Edit `docs/features/F023-mcp-unified-mounting.md` Timeline：

```
| 2026-04-XX | Phase B 全 AC（9-13）通过，worktree 同源验证成功 |
```

**Step 12.4: Commit**

```
docs(F023): Phase B 验收通过 — 根因 A/B/C 修 + Phase D 防御 + worktree 同源 [黄仁勋/Opus-47 🐾]
```

---

## 下一步

Phase A 已完成（6 commits）。Phase B 从 Task 7（根因 A 修复）开始，走 tdd 流程逐 task 推进。

每个 task 完成后按现有节奏 commit 到 F023 worktree；Phase B 全部完成后走 quality-gate → acceptance-guardian → requesting-review → merge-gate。
