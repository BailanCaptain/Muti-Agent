---
B-ID: B019
title: F018 模块六本地 embedding 永久不可用 — @huggingface/transformers 拉权重撞大陆网络墙，ensureModel 永降级，AC9.1/9.2 验收虚标
status: closed
related: F018 (上下文续接架构重建 — 模块六 Embedding Recall 后端)
reporter: 黄仁勋（小孙 2026-04-25 质疑"F018 真的跑了吗" → 实测 message_embeddings 表 0 行揭出）
created: 2026-04-25
closed: 2026-04-25
severity: P1
---

# B019 — F018 本地 embedding 永久不可用 + 二阶虚标

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | F018 模块六（Embedding Recall 后端）completed 1 周，**生产调用 = 0**：MCP 工具 `recall_similar_context` 永远返回空 hits，跨 session 语义召回完全失效。功能从外部看就是"接进来了但永远没结果"。 |
| 2 | **证据** | (a) `SELECT COUNT(*) FROM message_embeddings` = **0**（F018 完工 2026-04-18 → 实测 2026-04-25，期间 1856 条 messages 进库，零 embedding 写入）(b) `.runtime/api.log` **36 条** `F018 embedding model load failed (degraded to no-recall mode)` warn，全部错误体一致：`TypeError: fetch failed: Connect Timeout Error (attempted address: huggingface.co:443, timeout: 10000ms)` (c) 同步 36 条 `F018 embedding store skipped (model unavailable) reason=model-not-ready`，每条都附 messageId/threadId，证明 fire-and-forget hook 路径**全部触发**，不是 wiring 缺失 (d) 代码路径已确认接入：`server.ts:113 messages.setEmbeddingService(embeddingService)` + `message-service.ts:1197-1206 generateAndStore` fire-and-forget + `mcp/server.ts:310 recall_similar_context` 工具注册。 |
| 3 | **假设** | 根因 = `embedding-service.ts:163-165` 默认 `pipelineLoader` 用 `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` 直拉 `huggingface.co` → 大陆网络墙 → `undici` 10s ConnectTimeout → `ensureModel()` catch 返回 false + `loadPromise=null` 允许重试 → 每条 assistant 消息触发一次重试 → 永远 model-not-ready。"静默降级"（铁律 AC6.5）被忠实执行，但**降级后是永久不可用**，外部不可观测。 |
| 4 | **诊断策略** | 已完成：表行数实测（0）+ 日志 grep（36 + 36 配对）+ ConnectTimeout 错误体逐字核对 huggingface.co:443 + hook 路径源码核对（messageId 配对说明 hook 触发了）。链路三点闭环：hook 在跑 / 模型加载在挂 / 挂的原因是网络。 |
| 5 | **用户可见修正** | 修复后小孙跨 session 让 agent 用 `recall_similar_context` 召回历史，能拿到带语义相似度的 hits（不再 `(no relevant context found)`）；新消息落库后 `message_embeddings` 表行数随时间稳定增长；`api.log` 不再出现 `model-not-ready` warn。 |
| 6 | **复现验收** | (a) **回归实测**：修复后启动 API、跑 1 条 assistant 消息，等 5s 查 `SELECT COUNT(*) FROM message_embeddings` ≥ 1 (b) **召回实测**：调 MCP `recall_similar_context` 用历史关键词查询，返回 hits.length ≥ 1 且 score ∈ (0,1] (c) **离线模拟**：断网启动 API（模拟极端网络故障），ensureModel 仍能从本地 cache 加载成功（不依赖运行时拉 huggingface.co）(d) **回归保护**：单测覆盖 pipelineLoader 配置本地 cache_dir / `local_files_only=true` 路径，wired 后 `ensureModel()` 返回 true |

## 根因分析（架构级）

### 根因 A：F018 P5 把"网络可达 huggingface.co"当成隐式前提

`embedding-service.ts:163-165`：

```ts
this.pipelineLoader =
  deps.pipelineLoader ??
  (async () => {
    const { pipeline } = await import("@huggingface/transformers")
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  })
```

无 `cache_dir` / 无 `local_files_only` / 无任何离线 fallback。`@huggingface/transformers` 的默认行为是首次调用去 HF Hub 拉模型权重 + tokenizer.json + onnx → 写入 `~/.cache/huggingface/`。**首次拉权重不可达 = 终生不可用**。

P5 设计的"静默降级"（铁律不阻塞主流程）方向正确，但**没设计部署层的权重分发路径**。

### 根因 B：F018 AC9.1/9.2 验收虚标（二阶空壳）

F018 spec `docs/features/F018-context-resume-rebuild.md` 模块九 AC：
- AC9.1：跨 agent 验证 `recall_similar_context` 在真实使用中能找到历史
- AC9.2：embedding 落库一周抽查

Timeline 标 `post-merge 跨 agent / 手工验证`，但 grep 全仓 commit message + Timeline 条目，**没有任何记录证明 P5 merged 后真的跑过 `SELECT COUNT(*) FROM message_embeddings`** 或 真的调过 `recall_similar_context` 看 hits。

这跟 F007 模块五 AC5.2/AC5.5 当初虚标（代码全在生产调用 0）**是同一种病**。F018 立项动机就是修这种病，F018 自己又犯了一次 → **LL-004 二阶递归**。

## 修复方案（候选）

### 选项 A：HF 镜像（最小改动）

环境变量 `HF_ENDPOINT=https://hf-mirror.com`，`@huggingface/transformers` 自动改走镜像源拉权重。

- ✅ 改动 1 行 `.env`（但违反铁律「.env 不可变 — 改 .env 要人工操作」）
- ✅ 不改代码
- ❌ 仍依赖运行时网络（hf-mirror.com 也可能挂 / 限速）
- ❌ 镜像源稳定性不在我们控制范围
- ❌ 跨机器部署每台都得配

### 选项 B：本地预下载 + 仓库内分发（推荐）

把 `Xenova/all-MiniLM-L6-v2` 权重（~25MB ONNX + tokenizer）下载到 `models/all-MiniLM-L6-v2/`，commit 进仓库（或走 git-lfs / scripts/setup 脚本一次性拉）。代码改 `pipelineLoader` 传 `cache_dir` 指向本地 + `local_files_only=true`。

- ✅ 完全离线、首次启动即可用
- ✅ 跨机器部署不用配网络
- ✅ 修复 + 复现验收单测可直接走本地 fixture
- ❌ 仓库 +25MB（小模型可接受 / 走 git-lfs 更干净）
- ❌ 需要写一个 `scripts/download-models.ts` 一次性拉脚本（postinstall hook）

### 选项 C：ONNX 直跑（绕开 transformers.js）

直接用 `onnxruntime-node` 加载本地 .onnx，自己实现 mean-pooling + L2 normalize（已知 all-MiniLM-L6-v2 输出 384 维）。

- ✅ 完全自主、不依赖 transformers.js loader 行为
- ✅ 启动更快（绕过 HF Hub 探测）
- ❌ 改动最大，需要重写 `generateEmbedding`
- ❌ tokenizer 也得自己加载（BERT WordPiece），实现量翻倍

**倾向**：选项 B。最少代码改动 + 最稳运行时 + 最易跑回归。选项 A 作为 fallback（环境变量不写死 / 留口子），选项 C 是过度工程。

## 复现步骤（小孙侧零接触）

不需要小孙操作。直接：

```bash
# 1. 查表行数（应为 0）
sqlite3 data/multi-agent.sqlite "SELECT COUNT(*) FROM message_embeddings"

# 2. 查日志告警（应有大量 model-not-ready）
grep -c "model-not-ready" .runtime/api.log

# 3. 查错误根因（应全是 huggingface.co:443 ConnectTimeoutError）
grep "F018 embedding model load failed" .runtime/api.log | head -1
```

## 引入时间线

- F018 P5 commit `7a0e994`（2026-04-18）— `runContinuationLoop` 后 fire-and-forget `generateAndStore` 接入 + `server.ts` DI EmbeddingService
- F018 P5 commit `615eeff`（2026-04-18）— MCP `recall_similar_context` 注册 + CALLBACK_API_PROMPT 扩
- F018 commit / Timeline 标记 P5 done、AC 全 ✅、738/738 tests 绿
- 2026-04-18 → 2026-04-25：1856 条 messages 进库，0 embedding 写入；36 条 model-not-ready warn 累计
- 2026-04-25 小孙质疑"F018 真的跑了吗" → 黄仁勋实测发现表 0 行 → 立 B019

## 修复证物（dogfood EP-001 / LL-030）

> **EP-001 硬规则**：涉及外部可观测状态的 feature merge 时必须附**一行外部观测证物**（行数 / 字节数 / 计数），不能只是"代码 wiring + tests pass"。本节即 B019 自身的 dogfood 输出。

### 1. 修复 commits（fix/B019-embedding-offline-loader 分支）

- `086d13b` P1: 模型权重 commit (~23MB) + setup-models 脚本 + plan
- `43cffce` P2: pipelineLoader 离线优先 (env.localModelPath + allowRemoteModels=false + dtype:'q8')
- `c079823` P3: cosine 语义相似度测试守 quantized 推理质量
- `005bbb6` P4: scripts/B019-verify.ts service-level 验收脚本
- `8f9d188` 沉淀: EP-001 + LL-030 二阶虚标教训
- `924ae08` Option B 落地: quality-gate Step 0.6 EXTERNAL OBSERVABILITY CHECK
- `8053966` review P2-5: undici 8.1 → ^6 兼容 Node ≥20.9
- `02c5774` review P2-3: test withEnvSnapshot 恢复 transformers 全局 env
- `9a4e0e2` review P2-4: EMBEDDING_ALLOW_REMOTE=true 启动 warn
- `e83f991` review P1-1: 真启 createApiServer + 验 callback wiring + sqlite 写入

### 2. 真实外部观测输出

**API 启动**（`pnpm tsx packages/api/src/index.ts`）:
```
{"msg":"Server listening at http://[::]:8810"}
0 个 model-not-ready warns（vs F018 P5 完工 1 周内累计 36 条）
```

**SQL 行数**（`SELECT COUNT(*) FROM message_embeddings`）:
- F018 P5 完工 1 周（2026-04-18 → 2026-04-25）: **0 行**（1856 messages, 0 写入）
- B019 fix 后 e2e 临时库: **3 行**（B019-e2e-verify 写入 3, 全部可见）
- B019 fix 后 service-level 临时库: **5 行**（B019-verify 写入 5, 全部可见）

**Recall 召回**（`searchSimilarFromDb("kittens cats", ["thread-e2e"], 3, ...)`）:
```
3 hits
  score=0.3662 msg=msg-e2e-1 text="the cat sat on the mat..."
  score=0.3636 msg=msg-e2e-3 text="a feline rested on a soft rug..."
  score=0.1362 msg=msg-e2e-2 text="I love TypeScript..."
```

**Callback endpoint wiring**（`fetch /api/callbacks/recall-similar-context?query=test`）:
```
HTTP 401 (Invalid invocation identity)
responseTime: 4.27ms
→ endpoint 真挂载 + invocation auth 工作
```

**测试**:
- `pnpm test:api` → 980/980 pass
- `pnpm test:components` → 77/77 pass
- B019 单测 5 个 + helper restoration 测试 1 个: 全 pass
- B019 review P2 #4 escape-hatch warn 测试 2 个: 全 pass
- ensureModel 离线 0.5s 加载（vs F018 P5 完工每次 10s ConnectTimeout）

### 3. dogfood 自检（按 quality-gate Step 0.6）

> 本 fix 的 Why 写"修 F018 模块六虚标"——按 LL-030 + Step 0.6 ④，必须在 AC 里加一条"merge 后 7 天内真去查同位证据"。本节即"merge 前已查"的等价证物，**不留 post-merge 逃生口**（避免三阶递归 F007 → F018 → B019）。

- 外部最直接观测：`message_embeddings` 行数 — ✅ 已查（e2e: 3 行 / service: 5 行）
- recall 工具调用：✅ 已查（searchSimilarFromDb 返回 3 hits, 语义匹配正确）
- runtime warn 计数：`grep -c model-not-ready` — ✅ 0 条（vs 修前 36 条/周）
- F007 虚标对镜：F007 模块五"代码全在生产调用 0" → B019 fix 后"代码全在 + 生产调用真发生 + 行数真增长" — ✅

7 天 post-merge 复查时间窗：**2026-05-02** 前 grep production sqlite 看 `message_embeddings` 表行数随消息单调增长。

## 非目标（Out of Scope）

- 不改 F018 P5 的"静默降级"铁律（AC6.5 不变 — embedding 失败仍不阻塞主流程）
- 不改 F018 模块 1-5 / 模块 7 的 SessionBootstrap / TranscriptWriter / Auto-resume 设计（与本 bug 无关）
- 不动 `recall_similar_context` MCP 工具 schema（前端 / agent 调用契约不变）
- 不重新设计 embedding 模型（继续用 `Xenova/all-MiniLM-L6-v2` 384d，只换分发路径）
- 不补做 F018 全部 AC9.x 的 post-merge 抽查（B019 只闭"模型加载层"漏洞，验收虚标问题在 LL-004 / self-evolution 单独沉淀，不在本 bug scope）

## Links

- F018 上下文续接架构重建：`docs/features/F018-context-resume-rebuild.md`
- F007 上下文压缩优化（F018 立项动因，模块五同型空壳）：`docs/features/F007-context-compression-optimization.md`
- LL-004 判据（同一层第三次打补丁必须上抛架构层）：`multi-agent-skills/refs/shared-rules.md`
- 实测证物：`.runtime/api.log` 36 条 ensureModel/generateAndStore warn（2026-04-18 后全程）
- Memory Feedback「Measure Before Assert」：本 bug 的发现路径就是该 feedback 的兑现 — 小孙质疑 → 黄仁勋实测 → 揭出二阶虚标
