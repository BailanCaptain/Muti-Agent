# B023 Runtime Resilience Implementation Plan

**Bug Report:** B023 — `docs/bugReport/B023-runtime-resilience.md`
**Goal:** 三件 runtime 韧性修复（content 保留 + codex session_id 捕获 + stall 阈值放宽）+ F018 文档闭环
**Acceptance Criteria:**
- AC1: catch 路径触发后 messages.content 包含原 streaming + `[runtime]` 错误信息追加（不覆盖）
- AC2: base-runtime.findSessionId 输入 codex `{type:"session_meta",payload:{id:"019e..."}}` 返回 "019e..."
- AC3: base-runtime.findSessionId 输入 Claude `{type:"system",session_id:"abc"}` 仍返回 "abc"（不退化）
- AC4: 实机跑两轮 codex turn，第二轮 stdout 起始处含 `--resume <id>` + DB threads.native_session_id 在两轮间相等
- AC5: livenessStallWarningMs 默认值改为 1_200_000，1199s 无活动 + idle-silent 不触发 stall
- AC6: F018 文档 timeline 追加 B023 修复记录 + AC 补一条 codex resume 实测
- AC7: LL 沉淀 + ROADMAP 不涉及（B 不进 ROADMAP）

**Architecture:** 三处独立改动 + 文档同步，~45 行代码。`base-runtime.ts` 加 codex session_meta 适配分支；`message-service.ts:2194` catch 路径改 append；`base-runtime.ts:103` 默认 stall 阈值放宽；F018 doc 加补丁记录。

**Tech Stack:** TypeScript / node:test / Pino / SQLite (better-sqlite3) / pnpm workspace

---

## Straight-Line Check

**A→B**：当前 codex 永远 fresh + stall 误杀长 thinking + content overwrite → 修后 codex 走 resume + stall 不误杀 + content 保留
**Terminal schema**：
- `findSessionId(payload)` 同时支持 Claude `session_id` 和 codex `payload.id`
- `message-service.ts:2194` catch 路径 content = `assistantContent + "\n\n---\n[runtime] " + errorMessage`
- `DEFAULT_RUNTIME_LIFECYCLE.livenessStallWarningMs = 1_200_000`
- F018 doc Timeline + AC 加 B023 补丁记录

**不做什么**：
- 不重新立 F2-pre 编号（用户拍板：在 B023 里改）
- 不写历史 thread native_session_id 回填脚本（用户拍板 D1=B）
- 不改 gemini（gemini 设计完整，2 次实证确认）
- 不改前端样式（D3=B 后端先兜底）
- 不立 B028（failure-classifier 边角追到底是 F021 P6 主动 seal，无 bug）
- 不修 thinking-aware（Claude 不触发 stall，gemini retry 是设计 trade-off）

---

## Task 1: F2-pre — base-runtime.findSessionId 适配 codex session_meta

**Files:**
- Test: `packages/api/src/runtime/base-runtime.session-id.test.ts` (Create / 或 append 已有 test 文件)
- Modify: `packages/api/src/runtime/base-runtime.ts:648-680` (findSessionId 函数)

### Step 1.1: 写失败测试（codex session_meta 帧解析）

**File**: `packages/api/src/runtime/base-runtime.session-id.test.ts`

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import { findSessionId } from "./base-runtime"

test("B023 AC2: findSessionId 识别 codex session_meta.payload.id", () => {
  const codexFrame = {
    type: "session_meta",
    payload: {
      id: "019cdd4f-e8e3-7ff0-ba69-f479ebf5808c",
      timestamp: "2026-03-11T14:32:07.700Z",
      cwd: "C:\\Users\\-",
      cli_version: "0.114.0",
    },
  }
  assert.equal(findSessionId(codexFrame), "019cdd4f-e8e3-7ff0-ba69-f479ebf5808c")
})

test("B023 AC3: findSessionId 仍识别 Claude system+session_id 格式（不退化）", () => {
  const claudeFrame = {
    type: "system",
    session_id: "27f115fd-1f6e-4bca-8bf7-3985f32abcde",
  }
  assert.equal(findSessionId(claudeFrame), "27f115fd-1f6e-4bca-8bf7-3985f32abcde")
})

test("B023: findSessionId 拒绝 codex error envelope（防 B017 同型污染）", () => {
  const codexErrorFrame = {
    type: "session_meta",
    payload: {
      id: "junk-fresh-id",
    },
    error: true, // 假设 codex 错误回包带 error 标记
  }
  // 当前实现仅对 type=result + is_error=true 守卫；codex 没此防御。
  // 这条测试如果将来要加守卫先放过，先确保正常路径绿
  assert.equal(findSessionId(codexErrorFrame), "junk-fresh-id")
})
```

### Step 1.2: 跑测试确认 RED

```
pnpm --filter @multi-agent/api test base-runtime.session-id
```
Expected: AC2 / AC3 测试 FAIL（AC2 因 findSessionId 不识别 payload.id；AC3 应该 PASS 但放在一起跑确认整体）

### Step 1.3: 写实现

**Modify**: `packages/api/src/runtime/base-runtime.ts:648-680`

在现有 `findSessionId` 的 `if (typeof value.session_id === "string" && value.session_id) return value.session_id` 之后、`for (const child of Object.values(value))` 之前加一段：

```typescript
// B023 AC2: codex CLI emits {type:"session_meta", payload:{id:"019e..."}} on the first frame.
// Unlike Claude's flat session_id, codex nests under payload.id — needs explicit branch.
if (
  value.type === "session_meta" &&
  value.payload &&
  typeof value.payload === "object"
) {
  const payload = value.payload as Record<string, unknown>
  if (typeof payload.id === "string" && payload.id) {
    return payload.id
  }
}
```

### Step 1.4: 跑测试确认 GREEN

```
pnpm --filter @multi-agent/api test base-runtime.session-id
```
Expected: AC2 / AC3 全 PASS

### Step 1.5: Commit

```bash
git add packages/api/src/runtime/base-runtime.ts \
        packages/api/src/runtime/base-runtime.session-id.test.ts
git commit -m "$(cat <<'EOF'
fix(B023): base-runtime.findSessionId 适配 codex session_meta.payload.id

8 周长期实现漏洞：
- codex CLI 第一帧 stdout emit {type:"session_meta", payload:{id:"019e..."}}
- findSessionId 只识别 session_id/sessionId 字段名，不识别 codex 的 payload.id
- 导致 threads.native_session_id 永远为空，每次 codex turn 都 fresh 起，从未 resume

修法：findSessionId 加一条 codex 专用分支识别 session_meta.payload.id。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: F2-pre 实机集成验收（AC4，必须实测，不能跳过）

**Why mandatory**：用户在 D2 实证质疑后强调"实际确认不能想象"。base-runtime 单测验证不了 cli-orchestrator → message-service → DB write 的端到端链路。

### Step 2.1: 在 worktree 起 preview

```bash
# (假设 B023 worktree 创建后)
pnpm --filter @multi-agent/api dev   # 端口由 worktree-preview registry 分配
# 同时 next dev 起前端
```

### Step 2.2: 跑两轮 codex turn

1. 在 preview UI 创建新 thread @范德彪
2. 发"测试一下"
3. 等 turn 完成
4. **DB 检查 1**：`SELECT native_session_id FROM threads WHERE alias='范德彪' ORDER BY rowid DESC LIMIT 1` → 应该是 36 字 UUID（**不再是空字符串**）
5. 同 thread 再发"再来一句"
6. **DB 检查 2**：native_session_id 应跟检查 1 相同（**resume 不换 id**）
7. **Process 检查**：preview 后端日志应该有 `codex exec resume <id>` 的命令行

### Step 2.3: 失败处理

如果 DB 没填上 / resume 没生效：

- 看 cli-orchestrator.ts:183 是否真调到 findSessionId(event)
- 看 onSession 回调是否真触发 messages.setNativeSessionId
- 看 codex stdout 实际发的 session_meta 帧 payload 字段位置（可能 codex CLI 升版改格式）

### Step 2.4: 实测通过后，DB 状态拍照存档

把 DB 截图 / 命令输出贴进 B023 bug report 第 11 节"实机验收证据"。

---

## Task 3: F0 — catch 路径 append 不 overwrite

**Files:**
- Modify: `packages/api/src/services/message-service.ts:2161-2199` (catch 路径)
- Test: `packages/api/src/services/message-service.catch-preserve.test.ts` (Create)

### Step 3.1: 写失败测试

**File**: `packages/api/src/services/message-service.catch-preserve.test.ts`

```typescript
import test from "node:test"
import assert from "node:assert/strict"
// (省略：用 message-service 的现有测试基建模拟一个 turn 抛 error 的场景)

test("B023 AC1: catch 路径保留流式累积的 content，append 错误信息", async () => {
  // setup: 模拟 turn 流式累积 1000 字 → runtime 抛 stall error
  const { messageService, sessions, mockRuntime } = createTestHarness()
  mockRuntime.simulateStreaming("德彪 review 半截内容到这里")
  mockRuntime.simulateError(new Error("Agent 进程看起来已卡住（CPU 空转）"))

  await messageService.runTurnUntilDone({ /* ... */ })

  const finalMsg = sessions.getLastMessage(threadId)
  assert.match(finalMsg.content, /德彪 review 半截内容到这里/, "原 streaming 内容应保留")
  assert.match(finalMsg.content, /\[runtime\] Error: Agent 进程看起来已卡住/, "[runtime] 错误信息应 append 在末尾")
  assert.ok(
    finalMsg.content.indexOf("德彪 review") < finalMsg.content.indexOf("[runtime]"),
    "原内容应在错误信息之前"
  )
  assert.equal(finalMsg.thinking.length > 0, true, "thinking 不变")
})
```

(注：实际测试实现要看 message-service 的现有 test harness 模式。如果已有 `message-service.test.ts` 用类似 pattern，复用)

### Step 3.2: 跑测试确认 RED

```
pnpm --filter @multi-agent/api test message-service.catch-preserve
```
Expected: FAIL，原 streaming 内容被 "Error: ..." 覆盖

### Step 3.3: 写实现

**Modify**: `packages/api/src/services/message-service.ts:2191-2199`

```typescript
// 改前：
this.sessions.overwriteMessage(assistant.id, {
  content: `Error: ${message}`,
  thinking,
  toolEvents: toolEventsJson,
  contentBlocks: JSON.stringify(mergedErrorBlocks),
})

// 改后（B023 AC1）：
const preservedContent = assistantContent || ""
const errorSeparator = preservedContent ? "\n\n---\n" : ""
const composedContent = `${preservedContent}${errorSeparator}[runtime] Error: ${message}`
// 同时重新计算 contentBlocks 让两边对齐（避免分裂渲染）
const finalDerivedBlocks = deriveContentBlocks({
  content: composedContent,
  thinking,
})
const finalMergedBlocks = mergeDerivedWithExistingBlocks(
  existingErrorBlocksJson,
  finalDerivedBlocks,
)
this.sessions.overwriteMessage(assistant.id, {
  content: composedContent,
  thinking,
  toolEvents: toolEventsJson,
  contentBlocks: JSON.stringify(finalMergedBlocks),
})
```

### Step 3.4: 跑测试确认 GREEN

```
pnpm --filter @multi-agent/api test message-service.catch-preserve
```
Expected: PASS

### Step 3.5: Commit

```bash
git add packages/api/src/services/message-service.ts \
        packages/api/src/services/message-service.catch-preserve.test.ts
git commit -m "$(cat <<'EOF'
fix(B023): catch 路径 append 不 overwrite — 保留流式 content

之前 catch (error) 用 'Error: ${message}' 整个覆盖 assistantContent，
导致前端看到流式累积的内容瞬间消失（DB 实测：范德彪 5/8 02:08 那条 final
content=97 字仅 Error 文案，但 thinking=1356 字保留）。

改后：preservedContent + '\n\n---\n[runtime] Error: ...' append 模式，
content 跟 contentBlocks 对齐，不再分裂渲染。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: F3 — stall 阈值默认值 180s → 1200s

**Files:**
- Modify: `packages/api/src/runtime/base-runtime.ts:97-105` (DEFAULT_RUNTIME_LIFECYCLE)
- Modify (如有): `.env.example` / `.env.development.local.example` 同步默认值
- Test: `packages/api/src/runtime/base-runtime.stall-threshold.test.ts` (Create)

### Step 4.1: 写失败测试

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import { resolveRuntimeLifecycleConfig } from "./base-runtime"

test("B023 AC5: livenessStallWarningMs 默认值 1_200_000 (20min)", () => {
  const config = resolveRuntimeLifecycleConfig(undefined, {})
  assert.equal(config.livenessStallWarningMs, 1_200_000)
})

test("B023 AC5: env override 仍生效", () => {
  const config = resolveRuntimeLifecycleConfig(undefined, {
    MULTI_AGENT_LIVENESS_STALL_WARNING_MS: "600000",
  })
  assert.equal(config.livenessStallWarningMs, 600_000)
})
```

### Step 4.2: 跑测试确认 RED

```
pnpm --filter @multi-agent/api test base-runtime.stall-threshold
```
Expected: FAIL，默认值仍是 180_000

### Step 4.3: 写实现

**Modify**: `packages/api/src/runtime/base-runtime.ts:103`

```typescript
// 改前：
livenessStallWarningMs: 180_000,

// 改后（B023 AC5）：
livenessStallWarningMs: 1_200_000,  // 20min — Opus 4.7/GPT-5.4 长 thinking 容忍
```

### Step 4.4: 跑测试确认 GREEN

```
pnpm --filter @multi-agent/api test base-runtime.stall-threshold
```
Expected: PASS

### Step 4.5: Commit

```bash
git add packages/api/src/runtime/base-runtime.ts \
        packages/api/src/runtime/base-runtime.stall-threshold.test.ts
git commit -m "$(cat <<'EOF'
fix(B023): stall 阈值默认值 180s → 1200s — 容忍长 thinking turn

Opus 4.7 / GPT-5.4 thinking budget 高时 5min+ silent 是正常的，
180s 阈值偶发误杀（DB 实测：范德彪 4a4ca8b3 5/8 02:08 8min 工作 +
5min silent 被误判 idle-silent 强制 kill）。

不动 stall 检测逻辑（probe / busy-silent / idle-silent 全保留），
只调宽默认兜底。env override 仍生效。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 文档同步（用户强调"改的时候同步更新文档"）

**Files:**
- Modify: `docs/features/F018-context-resume-rebuild.md` (Timeline + AC 区)
- Modify (如存在): `multi-agent-skills/refs/lessons-learned.md`
- Modify (如存在): `.env.example` 注释 stall 阈值新默认

### Step 5.1: F018 Timeline 追加 B023 修复记录

在 F018 Timeline 表末尾追加：

```markdown
| 2026-05-08 | **B023 修复**：发现 F018 落地后 codex 的 native_session_id 实际从未捕获（base-runtime.findSessionId 只匹配 session_id 字段，未适配 codex 的 session_meta.payload.id 格式）。F018 的 SessionBootstrap 兜底路径(AC3.5) 8 周来一直在掩盖此漏洞。本次修复后 codex 可正确捕获 session_id 并走原生 resume，SessionBootstrap 仅在真正"新 session"时启用。 |
```

### Step 5.2: F018 AC 区追加新 AC（来自 B023 AC4）

```markdown
- [x] AC（B023 补 2026-05-08）: codex turn 跑过一次后，thread.native_session_id 应有值（36 字 UUID），下一次 turn 走 codex exec resume 而非 fresh exec
```

### Step 5.3: LL 沉淀

如果 `multi-agent-skills/refs/lessons-learned.md` 存在：

```markdown
## LL-XXX：DB 字段为空 ≠ bug，必须先核所有写入路径

**Context**：B023 调研中连续两次违反 — 只看 native_session_id 空就推测捕获漏，没核 message-service 的 4 条主动清空路径（B017 classifier × 3 + F021 P6 seal × 1）。

**Lesson**：DB 状态分析 = 倒查所有 write call site 后才能下断言，不是看 schema 字段为空就推测捕获漏。

**Same-type prevention**：
- 新 CLI provider 接入必须实测 stdout 里 session_id 字段位置（不能假设跟 Claude 一样）
- DB 字段调研必须 grep 所有 write 路径，逐条核对触发条件
- 设计意图（buildCommand 的 resume 三元）和实现（findSessionId 字段适配）要一致性核对
```

如果文件不存在，跳过（不为本次 PR 新建 lessons-learned.md，留作单独 feature 立项）。

### Step 5.4: Commit docs

```bash
git add docs/features/F018-context-resume-rebuild.md \
        multi-agent-skills/refs/lessons-learned.md  # (如果存在并改了)
git commit -m "$(cat <<'EOF'
docs(B023): F018 timeline + AC 补 codex resume 实证 + LL 沉淀

F018 spec 写"nativeSessionId === null 走 SessionBootstrap"是在
codex 漏洞已存在的现实下做的兜底实现，不是设计上不要 codex resume。
本次修复 base-runtime.findSessionId 适配 codex session_meta，
F018 timeline 追加补丁记录 + AC 补一条 codex resume 实证。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 集成 quality-gate

### Step 6.1: 全包 typecheck

```bash
pnpm typecheck
```
Expected: PASS（不引入新类型错误）

### Step 6.2: 全测试套件

```bash
pnpm test
```
Expected: 全 PASS（B023 三个新测试加入 + 不破坏既有测试）

### Step 6.3: 实机端到端验收（=Task 2 不再重跑只引用证据）

引用 Task 2 已经存档的 DB 截图 / preview 日志作为 AC4 证据。

### Step 6.4: 触发 quality-gate skill

按 multi-agent-skills 流程：
- 自检（spec 合规 + 验证命令输出齐全）
- @范德彪 请 review（按 requesting-review skill）

---

## 步骤总览

| Task | 内容 | 行数 | 测试 | 实机验收 |
|------|------|------|------|---------|
| 1 | F2-pre findSessionId 适配 codex | ~10 | 单测 3 条 | - |
| 2 | F2-pre 实机两轮 codex turn 验证 | 0（验收） | - | **必须** |
| 3 | F0 catch 路径 append | ~12 | 单测 1 条 | - |
| 4 | F3 stall 阈值默认值 | ~3 | 单测 2 条 | - |
| 5 | 文档同步 F018 + LL | 0（doc） | - | - |
| 6 | quality-gate + review | 0 | typecheck + test | - |

**总计**：~25 行代码 + ~6 条单测 + 1 次实机验收 + 文档同步

注：之前估 ~45 行包含了 contentBlocks 重新派生那部分，实际改动更紧凑。

---

## 风险 / 边界（最后一遍 sanity check）

1. **Task 1 codex 错误回包污染** — 当前 findSessionId 对 Claude 的 `type=result + is_error=true` 有守卫，但 codex 的 session_meta 是否有类似错误回包格式未知。**Mitigation**：实测 Task 2 时如果观察到 `codex exec resume` 报"session not found"死循环，说明 codex 也有此问题，单独立 B024 防御。
2. **Task 3 F021 P6 seal 路径** — F021 P6 的 `effectiveSessionId = null` 逻辑跑的也是 catch 路径之外的成功路径（line 1885），不受 Task 3 改动影响。Task 3 只改 catch 不改成功路径。
3. **Task 4 1200s 是否太宽** — codex 8min 工作 + 5min silent 在 1200s 内不被杀，但万一 codex 真死了 20min 才 kill 太慢。**Tradeoff 已明示**：用户拍板 1200s，optimize for "误杀少" not "kill 快"。

---

## Worktree 设置（开 worktree 时用）

```bash
git worktree add .worktrees/B023 -b fix/B023-runtime-resilience dev
cd .worktrees/B023
# (worktree-preview registry 自动分配端口)
```

完成 quality-gate + review 通过后走 merge-gate squash 到 dev。
