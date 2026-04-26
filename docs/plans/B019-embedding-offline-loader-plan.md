# B019 Implementation Plan — F018 模块六本地 embedding 离线化

**Bug:** B019 — `docs/bugReport/B019-f018-embedding-huggingface-offline.md`
**Goal:** F018 模块六本地 embedding 真正生效：`message_embeddings` 表随消息增长 + `recall_similar_context` 返回 hits（不再 `(no relevant context found)`）。
**Acceptance Criteria:**
1. `pnpm install` + `git clone` 后零网络依赖即可启动 API（不再撞 `huggingface.co:443 ConnectTimeoutError`）
2. 启动 API 后跑 1 条 assistant 消息，5s 内 `SELECT COUNT(*) FROM message_embeddings` ≥ 1
3. 调 MCP `recall_similar_context` 返回 hits.length ≥ 1，每条 hit `score ∈ (0, 1]` 且 `messageId` 真实存在
4. `.runtime/api.log` 不再出现 `model-not-ready` warn（连续 1h 跑 zero hit）
5. 单测：默认 pipelineLoader 实例化时 `cache_dir` 指向 `models/` 且 `local_files_only=true`
6. 集成测试：真实加载 `models/Xenova/all-MiniLM-L6-v2/` + `generateEmbedding("hello")` 返回 length=384 Float32Array
7. F018 Known Issues B019 status 更新为 closed + 链接修复 PR
**Architecture:** 模型权重直接 commit 仓库 `models/Xenova/all-MiniLM-L6-v2/`（~25MB），EmbeddingService 默认 pipelineLoader 改为传 `cache_dir: <project>/models` + `local_files_only: true`，env `EMBEDDING_ALLOW_REMOTE=true` 可放开（dev 升级模型用）。新增 `scripts/setup-models.ts` 一次性拉脚本（支持 `HF_ENDPOINT` 镜像），但**不在常规启动路径上**——只在更新模型时手动跑。
**Tech Stack:** `@huggingface/transformers`（已安装）/ `tsx` 跑脚本 / `node:test` + `assert/strict` 单测 / better-sqlite3 集成

---

## Pin Finish Line

**A → B**：A = `message_embeddings` 0 行 + 36 条 `model-not-ready` warn 永降级；B = 表行数随 messages 稳定增长 + recall 返回真 hits + 0 网络相关 warn。

**不做什么（Out of Scope）**：
- 不改 F018 P5 hook wiring（`server.ts:113` / `message-service.ts:1197-1206` / `mcp/server.ts:310` 全部不动）
- 不改 `recall_similar_context` MCP 工具 schema、callback 路径、CALLBACK_API_PROMPT 文案
- 不改 `cosineSimilarity` / `searchByVector` / `formatRecallResults` / `sanitizeRecallChunk` 算法
- 不补做 F018 全部 AC9.x 的 post-merge 抽查（虚标问题在 LL-028 单独沉淀，不在本 plan）
- 不换 embedding 模型（继续用 `Xenova/all-MiniLM-L6-v2`，384d，只换分发路径）
- 不引入 git-lfs（25MB 直接 commit 可接受）

## Terminal Schema

**目录结构**（终态）：
```
multi-agent/
├── models/
│   └── Xenova/
│       └── all-MiniLM-L6-v2/
│           ├── config.json
│           ├── tokenizer.json
│           ├── tokenizer_config.json
│           └── onnx/
│               └── model_quantized.onnx  (~25MB)
├── packages/api/src/services/
│   └── embedding-service.ts  (修改 pipelineLoader 默认实现)
└── scripts/
    └── setup-models.ts  (新增 — 仅供更新模型时手动跑)
```

**EmbeddingService.pipelineLoader 默认实现**（终态）：
```typescript
deps.pipelineLoader ??
(async () => {
  const { pipeline, env } = await import("@huggingface/transformers")
  // 强制走本地 cache，不撞 huggingface.co
  const projectRoot = path.resolve(__dirname, "../../../..")
  env.cacheDir = path.join(projectRoot, "models")
  env.allowRemoteModels = process.env.EMBEDDING_ALLOW_REMOTE === "true"
  env.allowLocalModels = true
  return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
})
```

**注**：`@huggingface/transformers` 用全局 `env` 配置，不是构造参数（与 Python transformers 不同）。Phase 0 Spike 验证。

---

## Phase 0: Spike — transformers.js cache layout 确认（限时 30 分钟）

**Why Spike**：不知道 transformers.js 默认 cache 落地路径是 `cache_dir/Xenova/all-MiniLM-L6-v2/` 直接结构，还是 `cache_dir/models--Xenova--all-MiniLM-L6-v2/snapshots/<sha>/` 的 HF Hub 风格结构。两种 layout 对应不同的"下载好放哪里"决策，错了 Phase 1 commit 进去的权重不会被 loader 找到。

**产出（决策，不是代码）**：
- transformers.js 默认 cache 落地路径模板（截屏或 `find ~/.cache/huggingface -type f` 结果）
- 是否需要指定 `env.cacheDir` + 文件 layout 规范
- `local_files_only` 在 transformers.js 里是 `env.allowRemoteModels=false` 还是构造参数

**步骤**：

```bash
# 1. 在主仓库（不动 worktree）跑一次默认拉取，看落到哪里
cd /c/Users/-/Desktop/Multi-Agent
HF_ENDPOINT=https://hf-mirror.com node -e "
const { pipeline } = require('@huggingface/transformers');
pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2').then(p => {
  console.log('loaded ok');
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"

# 2. 看 cache 落地路径
ls -R ~/.cache/huggingface/ 2>/dev/null || ls -R "$USERPROFILE/.cache/huggingface" 2>/dev/null
# Windows 可能在 %USERPROFILE%\.cache\huggingface\hub\
```

**判定**：
- ✅ 拉取成功 + 看到 cache 路径 → 记录路径模板，进 Phase 1
- ❌ hf-mirror.com 也不通 → fallback：手动从 https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/tree/main 下载 4 个文件，跳到 Phase 1 Step 2

**Spike 不进 commit，纯调研**。结论填进本 plan Phase 1 决定权重落地路径。

---

## Phase 1: 模型权重落库

### Task 1.1: 创建 setup-models 脚本

**Files:**
- Create: `scripts/setup-models.ts`

**Step 1: 写脚本**

```typescript
// scripts/setup-models.ts — 一次性下载 Xenova/all-MiniLM-L6-v2 到 models/
// 仅供首次 / 更新模型时手动跑：`pnpm tsx scripts/setup-models.ts`
// 支持 HF_ENDPOINT 镜像（大陆默认 hf-mirror.com）。

import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const modelsDir = path.join(projectRoot, "models")

// HF_ENDPOINT 默认走 hf-mirror.com（大陆友好）
process.env.HF_ENDPOINT = process.env.HF_ENDPOINT ?? "https://hf-mirror.com"

async function main() {
  const { pipeline, env } = await import("@huggingface/transformers")
  env.cacheDir = modelsDir
  env.allowRemoteModels = true  // 下载脚本时允许远程
  env.allowLocalModels = true

  console.log(`[setup-models] HF_ENDPOINT=${process.env.HF_ENDPOINT}`)
  console.log(`[setup-models] cacheDir=${modelsDir}`)
  console.log(`[setup-models] downloading Xenova/all-MiniLM-L6-v2 ...`)

  const start = Date.now()
  await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  console.log(`[setup-models] done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error(`[setup-models] FAILED:`, err)
  process.exit(1)
})
```

**Step 2: 跑脚本，落地权重**

```bash
cd /c/Users/-/Desktop/Multi-Agent/.worktrees/B019
pnpm tsx scripts/setup-models.ts
```

Expected: stdout 显示 `done in X.Xs`，`models/` 目录出现权重文件（具体 layout 由 Phase 0 决定）。

**Step 3: 验证文件结构**

```bash
find models/ -type f | sort
du -sh models/
```

Expected: 4 个文件（config.json + tokenizer.json + tokenizer_config.json + model_quantized.onnx），总大小 ~25MB。

**Step 4: Commit**

```bash
git add scripts/setup-models.ts models/
git commit -m "fix(B019 P1): 本地预下载 Xenova/all-MiniLM-L6-v2 ONNX 权重 (~25MB)

新增 scripts/setup-models.ts 一次性下载脚本，支持 HF_ENDPOINT
镜像（默认 hf-mirror.com）。模型权重直接 commit 进仓库 models/
目录，新机器 git clone 即用，零网络依赖。

仅供首次/更新模型时手动跑 \`pnpm tsx scripts/setup-models.ts\`，
不在常规启动路径上。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: 更新 .gitignore（如需）

**Files:**
- Modify: `.gitignore` — 确认 `models/` **不**在忽略列表

**Step 1: 检查**

```bash
grep -n "^models" .gitignore || echo "models/ not ignored — OK"
```

**Step 2: 如果 models/ 被忽略，移除**（按需）

不需要单独 commit（如有改动跟 Task 1.1 合并）。

---

## Phase 2: pipelineLoader 改造（TDD）

### Task 2.1: Red — 写失败测试覆盖默认 pipelineLoader 配置

**Files:**
- Modify: `packages/api/src/services/embedding-service.test.ts`

**Step 1: 写失败测试**

在文件末尾追加：

```typescript
describe("B019: default pipelineLoader is offline-first", () => {
  it("default pipelineLoader sets env.cacheDir to project models/ and disables remote", async () => {
    // Spy on @huggingface/transformers env to verify what defaults pipelineLoader writes
    const originalEnv = { ...process.env }
    delete process.env.EMBEDDING_ALLOW_REMOTE

    // We can't easily spy on transformers.js global env without mocking,
    // so we use DI: pass a custom loader that captures the env state at call time
    let capturedCacheDir: string | undefined
    let capturedAllowRemote: boolean | undefined
    let capturedAllowLocal: boolean | undefined

    const svc = new EmbeddingService({
      // Don't pass pipelineLoader — exercise default path
    })

    // Trigger default loader; will fail unless models/ exists, so we expect either
    // success or controlled failure. The contract we care about: loader did NOT
    // try to fetch huggingface.co at runtime (no ConnectTimeoutError).
    const ok = await svc.ensureModel()

    // After default loader runs, the global env should reflect our defaults
    const { env } = await import("@huggingface/transformers")
    assert.equal(env.allowRemoteModels, false, "EMBEDDING_ALLOW_REMOTE unset → allowRemoteModels=false")
    assert.equal(env.allowLocalModels, true, "always allow local models")
    assert.match(env.cacheDir ?? "", /[\/\\]models$/, "cacheDir ends with /models")

    // Restore env
    Object.assign(process.env, originalEnv)
  })

  it("EMBEDDING_ALLOW_REMOTE=true allows remote fallback", async () => {
    const originalEnv = { ...process.env }
    process.env.EMBEDDING_ALLOW_REMOTE = "true"

    const svc = new EmbeddingService({})
    await svc.ensureModel()

    const { env } = await import("@huggingface/transformers")
    assert.equal(env.allowRemoteModels, true, "env=true → allowRemoteModels=true")

    Object.assign(process.env, originalEnv)
  })
})
```

**Step 2: 跑测试确认 fail**

```bash
pnpm --filter @multi-agent/api test --test-name-pattern "B019"
```

Expected: FAIL — `env.allowRemoteModels` 当前默认 `true`（HF Hub 默认行为）。

### Task 2.2: Green — 改 pipelineLoader 默认实现

**Files:**
- Modify: `packages/api/src/services/embedding-service.ts:161-166`

**Step 1: 写实现**

```typescript
// 在 file 顶部加 import
import path from "node:path"
import { fileURLToPath } from "node:url"

// 在 EmbeddingService constructor 改默认 pipelineLoader
this.pipelineLoader =
  deps.pipelineLoader ??
  (async () => {
    const { pipeline, env } = await import("@huggingface/transformers")
    // B019: pipelineLoader 默认离线优先 — 不撞 huggingface.co:443
    // models/ 在仓库 root，相对 src 文件 4 层向上
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const projectRoot = path.resolve(__dirname, "../../../..")
    env.cacheDir = path.join(projectRoot, "models")
    env.allowRemoteModels = process.env.EMBEDDING_ALLOW_REMOTE === "true"
    env.allowLocalModels = true
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  })
```

**Step 2: 跑测试确认 pass**

```bash
pnpm --filter @multi-agent/api test --test-name-pattern "B019"
```

Expected: PASS。

**Step 3: 跑全 API 测试套件确认无 regression**

```bash
pnpm --filter @multi-agent/api test
```

Expected: 全绿（应该 ≥ 746 tests，原 F018 P5 完成时数）。

**Step 4: Commit**

```bash
git add packages/api/src/services/embedding-service.ts packages/api/src/services/embedding-service.test.ts
git commit -m "fix(B019 P2): pipelineLoader 默认离线优先 (cacheDir + allowRemoteModels=false)

EmbeddingService 默认 pipelineLoader 改用 transformers.js global env：
- env.cacheDir 指向项目 models/ 目录
- env.allowRemoteModels = (process.env.EMBEDDING_ALLOW_REMOTE === 'true')
  默认 false → 永远不撞 huggingface.co:443
- env.allowLocalModels = true

dev 升级模型时设 EMBEDDING_ALLOW_REMOTE=true 走 setup 脚本拉新版本。
生产/默认路径上 fail-fast，不依赖运行时网络。

Tests: 2 个新测试覆盖默认参数 + EMBEDDING_ALLOW_REMOTE 开关。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: 集成测试（真实路径）

### Task 3.1: Red — 写真实加载 + 推理集成测试

**Files:**
- Create: `packages/api/src/services/embedding-service.integration.test.ts`

**Step 1: 写测试**

```typescript
// B019 integration test — 真实 transformers + 真实本地权重
// 与单测分离：单测用 DI mock，集成测试验证生产路径
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "../../../..")

describe("B019 integration: offline embedding pipeline", () => {
  before(() => {
    // 前置：确认 models/ 权重存在；缺失说明 Phase 1 没跑或 commit 漏文件
    const modelsDir = path.join(projectRoot, "models")
    assert.ok(fs.existsSync(modelsDir), `models/ missing — run pnpm tsx scripts/setup-models.ts`)
  })

  it("default pipelineLoader loads local weights without network", async () => {
    const { EmbeddingService } = await import("./embedding-service")
    const svc = new EmbeddingService({})

    // 30s timeout — first load deserialize ONNX may take 5-15s on cold disk
    const ok = await svc.ensureModel()
    assert.equal(ok, true, "ensureModel succeeded with local weights")
  })

  it("generateEmbedding returns 384-dim Float32Array", async () => {
    const { EmbeddingService } = await import("./embedding-service")
    const svc = new EmbeddingService({})
    await svc.ensureModel()

    const vec = await svc.generateEmbedding("hello world")
    assert.ok(vec, "vec is not null")
    assert.equal(vec!.length, 384, "all-MiniLM-L6-v2 outputs 384-dim")
    assert.ok(
      vec!.every((x) => typeof x === "number" && Number.isFinite(x)),
      "all values are finite numbers",
    )
  })

  it("two semantically similar texts have cosine similarity > 0.5", async () => {
    const { EmbeddingService, cosineSimilarity } = await import("./embedding-service")
    const svc = new EmbeddingService({})
    await svc.ensureModel()

    const a = await svc.generateEmbedding("the cat sat on the mat")
    const b = await svc.generateEmbedding("a feline rested on a rug")
    const c = await svc.generateEmbedding("quantum chromodynamics in particle physics")

    assert.ok(a && b && c)
    const simAB = cosineSimilarity(a, b)
    const simAC = cosineSimilarity(a, c)
    assert.ok(simAB > 0.5, `similar texts cosine ${simAB.toFixed(3)} > 0.5`)
    assert.ok(simAB > simAC, `cat-feline (${simAB.toFixed(3)}) > cat-physics (${simAC.toFixed(3)})`)
  })
})
```

**Step 2: 跑测试**

```bash
pnpm --filter @multi-agent/api test packages/api/src/services/embedding-service.integration.test.ts
```

Expected: PASS（前提 Phase 1 权重已 commit）。

**Step 3: Commit**

```bash
git add packages/api/src/services/embedding-service.integration.test.ts
git commit -m "test(B019 P3): 集成测试覆盖真实本地权重加载 + 384d 向量 + 语义相似度

3 个集成测试验证生产路径：
- default pipelineLoader 加载本地权重不撞网络
- generateEmbedding 返回 384-dim Float32Array (all-MiniLM-L6-v2 维度)
- 语义相似度合理（cat ~ feline > cat ~ physics）

与单测分离（单测用 DI mock），集成测试守生产链路。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: 真实环境 AC 验收

### Task 4.1: 启动 worktree API 跑端到端

**Step 1: 启动 worktree API**

参考记忆 feedback「Worktree API Env Vars」：必须注 `API_PORT` + `SQLITE_PATH` 避开主库 :8787。

```bash
cd /c/Users/-/Desktop/Multi-Agent/.worktrees/B019
mkdir -p .runtime
API_PORT=8810 SQLITE_PATH=./data/b019.sqlite pnpm --filter @multi-agent/api dev > .runtime/api.log 2>&1 &
sleep 5
curl -s http://localhost:8810/api/health | head
```

Expected: API 健康 + log 头部不出现 `model-not-ready`。

**Step 2: 跑一条 assistant 消息（最小 reproducer）**

可以直接调 EmbeddingService.generateAndStore：

```bash
curl -X POST http://localhost:8810/api/callbacks/recall-similar-context \
  -H "Content-Type: application/json" \
  -d '{"query": "hello", "threadIds": [], "topK": 5}' | head
```

或起一个 thread + 发消息（完整 e2e）。

**Step 3: 查表行数 + log warn**

```bash
sqlite3 ./data/b019.sqlite "SELECT COUNT(*) FROM message_embeddings"
# Expected: ≥ 1（真发了消息）

grep -c "model-not-ready" .runtime/api.log
# Expected: 0
```

**Step 4: 调 recall_similar_context**

```bash
# 假设有 2 条 thread + 历史消息
curl -X POST http://localhost:8810/api/callbacks/recall-similar-context \
  -H "Content-Type: application/json" \
  -d '{"query": "<历史关键词>", "threadIds": ["<existing-thread-id>"], "topK": 3}'
```

Expected: hits.length ≥ 1，每条 score ∈ (0, 1]。

**Step 5: 落 AC 验收证据**

将 Step 1-4 的输出截图/日志保存到 `.agents/acceptance/B019/` 或贴回 B019 文档「复现验收」段。

不直接 commit（依据 F024 策略 B，验收证据不进 git）。

---

## Phase 5: 文档闭环 + 关闭 B019

### Task 5.1: 更新 B019 status

**Files:**
- Modify: `docs/bugReport/B019-f018-embedding-huggingface-offline.md`
  - frontmatter `status: open` → `status: closed`
  - 加 `closed: 2026-04-25` + `fix-pr: <PR-URL>` 字段
  - 末尾追加「修复证物」段（链 commit 列表 + AC 验收输出）

### Task 5.2: 更新 F018 Known Issues

**Files:**
- Modify: `docs/features/F018-context-resume-rebuild.md` Known Issues 段
  - B019 status 更新为 closed
  - 加 Timeline 条目：`2026-04-25 | B019 修复合入 | ...`

### Task 5.3: Commit

```bash
git add docs/bugReport/B019-f018-embedding-huggingface-offline.md docs/features/F018-context-resume-rebuild.md
git commit -m "docs(B019): close — 修复证物 + F018 Known Issues 同步

- B019 status: open → closed
- F018 Timeline 加 2026-04-25 修复合入条目
- Known Issues B019 标 closed

修复证物：
- Phase 1 commit <hash>: 模型权重落库 (~25MB)
- Phase 2 commit <hash>: pipelineLoader 离线优先
- Phase 3 commit <hash>: 集成测试覆盖
- AC 验收：message_embeddings ≥ 1 / 0 model-not-ready warn / recall hits ≥ 1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6: 走 quality-gate → review → merge-gate

按 CLAUDE.md 流程链：

1. `quality-gate` 自检 — typecheck / check-docs / lint-staged / 全测试套件 / 愿景三问
2. `acceptance-guardian` ⚠ — 按记忆 feedback「Skip Acceptance Guardian for Test-Infra」**B019 是 backend 修复 + 测试基础设施类**，AC = 命令输出（SQL + log grep + 单测 + 集成测试），quality-gate 已等价验收 → **跳过 acceptance-guardian**
3. `requesting-review` — @范德彪（Codex）做对抗 review，检查 pipelineLoader 改造 + transformers.js env 全局副作用 + 单测断言强度
4. `receiving-review` — 闭环 P1/P2，VERIFY 三道门
5. `merge-gate` — 合入 dev（PR + squash + Phase 同步 + 5a-0/5a/5b/5c 清理 worktree）

---

## Bite-Sized Task Summary

| # | Phase | Task | 时长 | 类型 |
|---|-------|------|------|------|
| 0 | Spike | transformers.js cache layout 调研 | 30 min | 决策 |
| 1.1 | P1 | 写 setup-models 脚本 | 5 min | 实现 |
| 1.2 | P1 | 跑脚本拉权重 | 2-5 min | 操作 |
| 1.3 | P1 | 验证文件结构 | 2 min | 验证 |
| 1.4 | P1 | Commit Phase 1 | 1 min | git |
| 2.1 | P2 | Red 测试 (DI 默认参数 + 开关) | 5 min | 测试 |
| 2.2 | P2 | 跑测试 fail | 1 min | 验证 |
| 2.3 | P2 | Green 改 pipelineLoader | 5 min | 实现 |
| 2.4 | P2 | 跑测试 pass + 全套 regression | 2 min | 验证 |
| 2.5 | P2 | Commit Phase 2 | 1 min | git |
| 3.1 | P3 | 写集成测试 (真实加载 + 384d + 相似度) | 8 min | 测试 |
| 3.2 | P3 | 跑集成测试 pass | 2 min | 验证 |
| 3.3 | P3 | Commit Phase 3 | 1 min | git |
| 4.1 | P4 | 启 worktree API | 2 min | 操作 |
| 4.2 | P4 | 端到端 AC 验收 | 5 min | 验证 |
| 5.1 | P5 | 更新 B019 / F018 status | 3 min | docs |
| 5.2 | P5 | Commit Phase 5 | 1 min | git |
| 6 | — | quality-gate → review → merge-gate | 串行 | 流程 |

**预计总时长**：约 1.5 小时（Phase 0 Spike + Phase 1-5 实现），不含 review 闭环。

## Risk Map

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| hf-mirror.com 也撞墙 | 低 | 高（Phase 1 卡死）| Spike 兜底：手动从 mirror 网站下 4 个文件放 models/ |
| transformers.js cache layout 与预期不符 | 中 | 中（重新规划权重路径）| Phase 0 Spike 显式覆盖 |
| 25MB 二进制 commit 触发 GitHub 限制 | 低 | 中（要切 git-lfs）| GitHub 单文件 100MB 上限，25MB 安全；如挂切 git-lfs Phase 1.5 |
| transformers.js env 全局状态污染其他测试 | 中 | 中（test isolation 失效）| Codex review 时重点检查；测试加 before/after 恢复 env |
| 集成测试在 CI 里跑慢 | 中 | 低（CI 时间 +10-20s）| 标 `skip: process.env.CI === "true"` 或单独 test:integration target |

## Links

- Bug doc: `docs/bugReport/B019-f018-embedding-huggingface-offline.md`
- F018 spec: `docs/features/F018-context-resume-rebuild.md`
- F018 Plan（参考结构）: `docs/plans/f018-context-resume-rebuild-plan.md`
- transformers.js docs: https://huggingface.co/docs/transformers.js — `env` global config
- HF mirror: https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/tree/main
