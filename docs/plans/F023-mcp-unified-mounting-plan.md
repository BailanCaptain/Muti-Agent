# F023 三家 MCP 挂载统一 + 弃 CALLBACK_API_PROMPT Implementation Plan

**Feature:** F023 — `docs/features/F023-mcp-unified-mounting.md`
**Goal:** 三家 CLI（Claude / Codex / Gemini）统一通过项目级官方配置挂载 `multi_agent_room` MCP server；删除 runtime 临时 `--mcp-config` + `mkdtemp` 路径和 `CALLBACK_API_PROMPT` 指令。
**Acceptance Criteria:**
- AC1: Claude runtime 工具列表含 `mcp__multi_agent_room__take_screenshot` 等 MCP 工具
- AC2: Codex runtime 能直接调用 MCP 工具（通过 `.codex/config.toml`）
- AC3: Gemini runtime 能直接调用 MCP 工具（通过 `.gemini/settings.json`）
- AC4: `packages/api/dist/mcp/server.js` 由 build 流程保证与 `src/mcp/server.ts` 同步
- AC5: `claude-runtime.ts` 中 `mkdtemp` / `writeFileSync(mcp-config.json)` / `--mcp-config` 全删
- AC6: 全项目源码（`packages/api/src/**`）grep `CALLBACK_API_PROMPT` 和 `Callback API` 零匹配
- AC7: `agent-prompts.test.ts` 中 `Callback API` 断言删除或重写，pnpm test 全绿
- AC8: 三家联动实际跑一次——Codex/Gemini 通过 MCP 调 `post_message` 或 `take_screenshot`，前端看到结果

**Architecture:** 照搬 clowder-ai 验证过的模式——项目根放三份同构的官方 MCP 配置文件，全部指向稳定的 `packages/api/dist/mcp/server.js`（绝对路径）。动态 token 靠进程继承链（base-runtime spawn 时 `env: {MULTI_AGENT_*}` 已传）。Gemini 配置需额外写 `env: {VAR: "${VAR}"}` 触发 CLI 侧展开，Claude/Codex 裸继承即可。

**Tech Stack:** Node.js / TypeScript / 三家官方 CLI 配置规范 / pnpm 工作流

**Not doing:**
- 不动 `getCallbackIdentity()` 读 env 的逻辑（已就绪）
- 不动 `packages/api/src/mcp/server.ts` 里的工具注册（F018/F019 已注册足够）
- 不做 monorepo 拆 `packages/mcp-server` 子包（单包足够）
- 不做跨机器可移植——本项目只在小孙的 Windows 桌面跑，绝对路径接受

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

## 下一步

计划写完 → 进入 `worktree`（创建 F023 隔离开发环境）→ `tdd`（Task 1 开始实现）。
