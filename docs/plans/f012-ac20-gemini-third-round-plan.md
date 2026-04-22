# F012 AC-20 Gemini 第 3 轮 Implementation Plan

**Feature:** F012 — `docs/features/F012-frontend-hardening-redesign.md`
**Goal:** `readGeminiThoughtsFromSession` 能在真实 Gemini CLI 产物（两种文件布局）上读出 thoughts，前端 Gemini 思考气泡显示 subject/description
**Acceptance Criteria:**
- AC-20 Gemini 子项：本地 session 文件回读方案可用（两种文件布局都覆盖）
- AC-23：手动验证 Gemini 在前端"深度思考"折叠块中可见 subject/description 拼接内容

**Architecture:**
- 放弃字符串拼路径；改为扫 `chats/` 一级 JSON + 二级 UUID 子目录，按 mtime 降序取最近 50 候选，逐个 `JSON.parse` 读文件内 `sessionId` 字段精确匹配
- 保持 `readGeminiThoughtsFromSession(sessionId, opts)` 外签名不变；调用点 `gemini-runtime.ts:79` 不动
- **E2E 测试不 mock fs**：tmp 目录真建两种布局的 fixture，真 readdir/readFile（防 LL-015 复发）

**Tech Stack:** Node fs/promises (`readdir`/`readFile`/`stat`/`mkdtemp`/`writeFile`)，vitest，Gemini CLI 实盘

**Non-goals:**
- 不重构 `formatGeminiThoughts`（6190a3b 已定型）
- 不动 `GeminiRuntime.afterRun` 调用点/时序
- 不动 stderr 噪音过滤（6190a3b 已扩）
- 不在本轮解决"新格式 short-sid ≠ UUID nativeSessionId"的深层问题（如 Spike 发现不对等，走降级匹配而非改 GeminiRuntime 捕获 short-sid）

---

## Task 0: Spike — Gemini CLI sessionId 对账（限时 15 min）

**目的（决策，非交付）：** 确认我们传入的 `MULTI_AGENT_NATIVE_SESSION_ID` 与 Gemini CLI 实际写入 session 文件 `sessionId` 字段的**对应关系**，选择匹配策略。

**动作：**
1. 清理 `~/.gemini/tmp/multi-agent/chats/` 里临时文件时间戳基线（不删，只记 mtime 最大值）
2. 手动起一次 Gemini CLI：
   ```bash
   node packages/api/dist/runtime/... # 或直接 pnpm dev:api 里新建一个 Gemini thread，发一条"你好，简单思考一下"的消息
   ```
3. CLI 跑完后：
   - 查数据库 `threads.nativeSessionId` 最新值（记为 `NS`）
   - 列 `~/.gemini/tmp/multi-agent/chats/` 里 mtime 最新的文件/目录（记为 `FP`）
   - 对比 `FP` 内部 `parsed.sessionId` vs `NS`
4. 判定：
   - **Case A**：`parsed.sessionId === NS` → 走"精确匹配"主路径（计划 Task 1-2 如现写）
   - **Case B**：不等（比如 short-sid 格式）→ 走降级："按 mtime 最新 + projectHash 匹配 + lastUpdated 靠近本次 invoke 结束时间"

**Output（落盘到 plan 文件末尾 Spike Log）：**
```
NS = <uuid>
FP = <path>
parsed.sessionId = <value>
决策 = Case A | Case B
```

**若超时（>15 min）未定论**：默认 Case A 推进，并把 Case B 降级作为 Task 2 的备选分支标注；不阻塞 Task 1 进入。

---

## Task 1: `readGeminiThoughtsFromSession` 重写 — 平铺格式路径扫描 + sessionId 精确匹配

**Files:**
- Modify: `packages/api/src/runtime/gemini-session-reader.ts:26-61`
- Test: `packages/api/src/runtime/gemini-session-reader.test.ts`（改写）

### Step 1.1: 写失败测试（平铺格式真 FS）

把现有 mock-fs 测试全删，改写成 `mkdtemp` + 真 `writeFile` 的 E2E 风格：

```typescript
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiThoughtsFromSession } from "./gemini-session-reader";

describe("readGeminiThoughtsFromSession (real FS)", () => {
  let fakeHome: string;
  beforeEach(async () => { fakeHome = await mkdtemp(join(tmpdir(), "gem-reader-")); });
  afterEach(async () => { await rm(fakeHome, { recursive: true, force: true }); });

  it("flat format: reads thoughts by matching sessionId inside file", async () => {
    const chatsDir = join(fakeHome, ".gemini", "tmp", "multi-agent", "chats");
    await mkdir(chatsDir, { recursive: true });
    const sid = "0d356375-bb4c-4301-b6f7-4c491c699037";
    // 故意用 Gemini CLI 真实文件名格式（与 sid 不直接对等，有 timestamp 前缀）
    await writeFile(join(chatsDir, "session-2026-04-22T01-00-0d356375.json"), JSON.stringify({
      sessionId: sid,
      projectHash: "abc",
      messages: [
        { type: "user", content: "hi" },
        { type: "gemini", content: "yo", thoughts: [
          { subject: "Thinking", description: "about the task" }
        ]}
      ]
    }));

    const result = await readGeminiThoughtsFromSession(sid, {
      home: fakeHome, projectDir: "multi-agent"
    });

    expect(result).toEqual([{ subject: "Thinking", description: "about the task" }]);
  });
});
```

### Step 1.2: 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
**Expected:** FAIL — 当前实现拼 `session-${sid}.json`，文件叫 `session-...-0d356375.json`，读不到 → 返回 `[]`，断言失败。

### Step 1.3: 最小实现（只支持平铺扫描）

```typescript
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_CANDIDATES = 50;

export async function readGeminiThoughtsFromSession(
  sessionId: string, opts: ReadOptions
): Promise<GeminiThought[]> {
  const chatsDir = join(opts.home ?? homedir(), ".gemini", "tmp", opts.projectDir, "chats");
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);

  const candidates: { path: string; mtime: number }[] = [];
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith(".json")) {
      const p = join(chatsDir, ent.name);
      const st = await stat(p).catch(() => null);
      if (st) candidates.push({ path: p, mtime: st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const parsed = JSON.parse(await readFile(c.path, "utf8")) as GeminiSessionFile & { sessionId?: string };
      if (parsed.sessionId !== sessionId) continue;
      const geminiMsgs = (parsed.messages ?? []).filter((m) => m.type === "gemini");
      if (geminiMsgs.length === 0) return [];
      const last = geminiMsgs[geminiMsgs.length - 1];
      return (last.thoughts ?? []).filter((t) => t && (t.subject || t.description));
    } catch { /* skip bad file */ }
  }
  return [];
}
```

### Step 1.4: 跑测试确认通过

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
**Expected:** PASS（Task 1 的平铺用例绿；老 mock-fs 用例已删）

### Step 1.5: Commit

```bash
git add packages/api/src/runtime/gemini-session-reader.ts \
        packages/api/src/runtime/gemini-session-reader.test.ts
git commit -m "fix(F012 AC-20): gemini-session-reader 平铺格式扫描 + sessionId 精确匹配"
```

---

## Task 2: UUID 子目录格式支持

**Files:**
- Modify: `packages/api/src/runtime/gemini-session-reader.ts`（Task 1 产物之上扩展）
- Test: `packages/api/src/runtime/gemini-session-reader.test.ts`（追加）

### Step 2.1: 追加 UUID 子目录失败测试

```typescript
it("uuid-dir format: reads thoughts from <uuid>/<file>.json", async () => {
  const chatsDir = join(fakeHome, ".gemini", "tmp", "multi-agent", "chats");
  const uuidDir = join(chatsDir, "74094079-bcf8-4ee2-b9ab-79581f6bd69f");
  await mkdir(uuidDir, { recursive: true });
  const sid = "hr5vby";  // Case A 或 Spike 决策后选正确字段
  await writeFile(join(uuidDir, "hr5vby.json"), JSON.stringify({
    sessionId: sid,
    projectHash: "abc",
    messages: [
      { type: "gemini", content: "yo", thoughts: [
        { subject: "NestedDir", description: "should find via subdir scan" }
      ]}
    ]
  }));

  const result = await readGeminiThoughtsFromSession(sid, {
    home: fakeHome, projectDir: "multi-agent"
  });

  expect(result).toEqual([{ subject: "NestedDir", description: "should find via subdir scan" }]);
});

it("returns empty array if no sessionId matches", async () => {
  const chatsDir = join(fakeHome, ".gemini", "tmp", "multi-agent", "chats");
  await mkdir(chatsDir, { recursive: true });
  await writeFile(join(chatsDir, "session-2026-04-22T01-00-other.json"), JSON.stringify({
    sessionId: "other-id", messages: []
  }));
  const result = await readGeminiThoughtsFromSession("my-id", {
    home: fakeHome, projectDir: "multi-agent"
  });
  expect(result).toEqual([]);
});

it("returns empty array if chatsDir does not exist", async () => {
  const result = await readGeminiThoughtsFromSession("any", {
    home: fakeHome, projectDir: "nonexistent-project"
  });
  expect(result).toEqual([]);
});
```

### Step 2.2: 跑测试确认 UUID 子目录失败

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
**Expected:** UUID 子目录用例 FAIL（Task 1 实现只扫一级 JSON），其他 PASS

### Step 2.3: 扩展 reader 扫二级子目录

在 Task 1 的 `for (const ent of entries)` 循环里追加：

```typescript
} else if (ent.isDirectory()) {
  const subDir = join(chatsDir, ent.name);
  const subEntries = await readdir(subDir).catch(() => []);
  for (const f of subEntries) {
    if (!f.endsWith(".json")) continue;
    const p = join(subDir, f);
    const st = await stat(p).catch(() => null);
    if (st) candidates.push({ path: p, mtime: st.mtimeMs });
  }
}
```

### Step 2.4: 全绿

```bash
pnpm --filter @multi-agent/api test -- gemini-session-reader
```
**Expected:** 4 个用例全 PASS（flat / uuid-dir / no-match / no-dir）

### Step 2.5: Commit

```bash
git add packages/api/src/runtime/gemini-session-reader.ts \
        packages/api/src/runtime/gemini-session-reader.test.ts
git commit -m "fix(F012 AC-20): gemini-session-reader 扩 UUID 子目录格式"
```

---

## Task 3: 全量测试 + typecheck + biome 回绿

### Step 3.1: 全量测试

```bash
pnpm --filter @multi-agent/api test
```
**Expected:** 全绿（gemini-runtime-thinking.test.ts 可能需要微调，因为它 mock `readGeminiThoughtsFromSession` —— 已 mock 的不受影响）

### Step 3.2: typecheck + biome

```bash
pnpm typecheck
pnpm biome check packages/api/src/runtime/gemini-session-reader.ts \
                 packages/api/src/runtime/gemini-session-reader.test.ts
```
**Expected:** 无错误

### Step 3.3: Commit（如有微调）

---

## Task 4: 手动 UI 端到端验收（AC-23 Gemini 分支）

**这一步不能省**（LL-022：测试金字塔在 UI 呈现上是倒的，手动验证 > 单元测试）。

### Step 4.1: 起 worktree preview（F024 基础设施）

```bash
pnpm worktree:preview  # 或按 F024 的 L1 preview 命令
```
记录分配的端口（:31xx / :88xx）。

### Step 4.2: 打开浏览器，新建 Gemini 会话

访问 preview URL → 新建 Gemini thread → 发："帮我分析一下这个项目的架构"（触发多轮思考）

### Step 4.3: 观察并截图

- 消息气泡底部"深度思考"折叠块存在
- 展开折叠块：看到 `### 1. Subject\n\nDescription` 标题式排版
- 内容**不是** stderr/错误栈/"refreshAuth failed"噪音
- 内容**不是** 空白

**若空白或乱码** → Spike Case B 未处理或匹配逻辑有 bug，回 Task 0 重查。

### Step 4.4: 数据库抽样核对

```bash
sqlite3 data/multi-agent.sqlite "SELECT LENGTH(thinking), SUBSTR(thinking,1,200) FROM messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 3;"
```
**Expected:** 最近的 Gemini 消息 `thinking` 字段非空，含 subject/description 格式的 markdown 文本

### Step 4.5: 保存证据

截图 + DB 查询结果贴到 F012 聚合文件 Timeline / AC-20 Gemini 子项下作为验收证物。

---

## Task 5: F012 AC 勾选 + Timeline 收尾

**Files:**
- Modify: `docs/features/F012-frontend-hardening-redesign.md`

### Step 5.1: 勾选 AC

- `AC-20 Gemini CLI：本地 session 文件回读方案` `[ ]` → `[x]`
- `AC-23` Gemini 分支若已手动验证 → 文字说明"Gemini ✅（证据：截图路径 + DB 查询）"

### Step 5.2: Timeline 追加完成条目

```
| 2026-04-22 | AC-20 Gemini 第 3 轮完成 | 路径扫描 + sessionId 内容精确匹配；E2E 测试不 mock fs（LL-015）；4 个测试用例全绿；手动 UI 验收通过 |
```

### Step 5.3: Commit

```bash
git commit -m "docs(F012): AC-20 Gemini ✅ + AC-23 Gemini 分支验收" \
  docs/features/F012-frontend-hardening-redesign.md
```

---

## Spike Log（Task 0 产出，动手时填）

```
<实测时填>
```

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| Spike Case B（short-sid ≠ UUID）成立 | Task 1 的"sessionId 精确匹配"不命中任何文件 → 测试都 PASS（因为 mock 数据里 sid 对齐），但真跑 Gemini 不 work。Task 4 手动验证会兜底暴露。此时回 Task 0 扩展匹配策略（按 projectHash + mtime + lastUpdated 三元组启发式） |
| 老 mock-fs 测试删除影响其他测试 | 查 grep 确认只有 `gemini-session-reader.test.ts` 用 mock-fs 写 session 文件；`gemini-runtime-thinking.test.ts` 是另外的文件，它 mock 整个 `readGeminiThoughtsFromSession` 不走 fs |
| 扫 50 个候选太慢 | 本地实测 `~/.gemini/tmp/multi-agent/chats/` 已有 ~3 UUID 目录 + ~100 平铺文件，读前 50 个最近 JSON 每个 < 1MB，总耗时 < 300ms，afterRun 可接受 |

## 估时

| Task | 预期 |
|------|------|
| Task 0 Spike | 15 min |
| Task 1 平铺扫描 | 25 min |
| Task 2 UUID 子目录 | 15 min |
| Task 3 typecheck/全量 | 10 min |
| Task 4 手动 UI | 15 min |
| Task 5 文档收尾 | 10 min |
| **总计** | **~90 min** |
