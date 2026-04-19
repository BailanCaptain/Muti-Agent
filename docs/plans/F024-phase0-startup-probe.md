---
id: F024-P0
title: F024 Phase 0 — 启动链路参数化调研报告
owner: 黄仁勋
created: 2026-04-19
---

# F024 · P0 调研报告 — 启动链路参数化可行性

## TL;DR

**API 侧核心已参数化 ✅，但三处数据目录硬编码需要改造 ❌。Web 侧是 Next.js，端口通过 `-p` 可切，运行时 API 指向靠 `NEXT_PUBLIC_API_*` env，需要每 worktree 独立 env 文件。**

**结论：P1（L1 核心）工作量可控。主要新增工作在：**
1. 抽出 `uploadsDir` 为配置项
2. 抽出 `docs/runtime-events` 写入路径为配置项
3. 新建 `.worktree-ports` 注册表机制
4. 编写 worktree preview 启动脚本（组装 env 启动 API + Web）

---

## 1. API 启动链路（packages/api）

### 1.1 已参数化 ✅

`packages/api/src/config.ts:3-11` — 全部走 env，无硬编码：

| 配置项 | env 变量 | 默认值 |
|--------|----------|--------|
| port | `API_PORT` | 8787 |
| host | `API_HOST` | `::` |
| corsOrigin | `CORS_ORIGIN` | `http://localhost:3000` |
| apiBaseUrl | `API_BASE_URL` | `http://localhost:${API_PORT}` |
| sqlitePath | `SQLITE_PATH` | `./data/multi-agent.sqlite` |
| redisUrl | `REDIS_URL` | `""` |

**transcripts 目录跟随**：`server.ts:76` — `TranscriptWriter({ dataDir: dirname(sqlitePath) })`。只要 `SQLITE_PATH` 变，threads transcripts 自动跟着走。

### 1.2 硬编码点 ❌（P1 要改的地方）

| 位置 | 硬编码内容 | 影响 |
|------|------------|------|
| `server.ts:267` | `uploadsDir = path.resolve(__dirname, "../../../.runtime/uploads")` | 多 worktree 共享同一个 uploads 目录，验收证据会互相污染 |
| `runtime/event-recorder.ts:24` | `path.resolve(process.cwd(), "docs", "runtime-events")` | worktree cwd 不同则天然隔离，但写入主仓 `docs/` 目录违反"验收不污染主仓"原则 |
| `services/memory-service.ts:128,164` | `cwd: process.cwd()` | 传入子进程的 cwd，跟 worktree 走，**已天然隔离** ✓ |

### 1.3 改造建议（不在本 P0 实施，留给 P1）

```ts
// config.ts 新增
uploadsDir: process.env.UPLOADS_DIR ?? path.resolve(__dirname, "../../../.runtime/uploads"),
runtimeEventsDir: process.env.RUNTIME_EVENTS_DIR ?? path.resolve(process.cwd(), "docs", "runtime-events"),
```

`server.ts:267` 和 `event-recorder.ts:24` 改为读配置。

---

## 2. Web 启动链路（根目录 Next.js）

### 2.1 端口 ✅

`package.json:11` — `next dev` 默认 3000。Next.js 原生支持 `next dev -p <port>`，无需代码改造。

### 2.2 API 指向 ⚠️

所有 `components/**/*.ts(x)` 读取 `NEXT_PUBLIC_API_HTTP_URL` / `NEXT_PUBLIC_API_WS_URL`（调研发现 13 处引用，全部有 `?? "http://localhost:8787"` fallback）。

- **dev 模式**：Next.js 运行时读 `process.env`，per-worktree 设置不同 env 即可
- **prod 模式**：`NEXT_PUBLIC_*` 编译期烘焙，构建时传 env

**worktree preview 是 dev 模式**，所以**无需改代码**，只需启动脚本按 worktree 分配的端口组装 env。

### 2.3 潜在坑

- 13 处 fallback 写成 `http://localhost:8787` —— worktree 如果漏传 env，会偷偷连到主仓的 API（如果主仓此时在跑）。**P1 需要在启动脚本里强制 fail-fast**：env 未设置就拒绝启动。

---

## 3. 数据目录与持久化清单

| 资源 | 当前路径 | 是否 worktree 隔离 | 风险 |
|------|----------|---------------------|------|
| SQLite DB | `SQLITE_PATH`（可配） | ✅ 可参数化 | 低 |
| SQLite WAL/SHM | 跟随 SQLITE_PATH | ✅ | 低 |
| Transcripts (threads) | `dirname(SQLITE_PATH)/threads/` | ✅ 跟随 SQLITE_PATH | 低 |
| Uploads | `.runtime/uploads/` 硬编码 | ❌ | **高** — 截图会串 |
| Runtime events | `docs/runtime-events/`（cwd） | ⚠️ worktree cwd 隔离但污染主仓 docs | 中 |
| Runtime config | `multi-agent.runtime-config.json`（cwd） | ✅ cwd 隔离 | 低 |
| Preview gateway ports | 内存态 + `runtimePorts` 配置 | ✅ | 低 |
| MCP 配置 / skills | 由 `scripts/mount-skills.sh` 挂载 | ⚠️ 需确认是否写主仓 | 待查 |

---

## 4. 端口注册表（`.worktree-ports`）

**当前不存在**。F024 kickoff 风险表提到此方案。需要新建。

### 建议方案（待讨论）

文件：`<主仓>/.worktree-ports.json`（主仓单一真相源，不进 worktree 内部）

```json
{
  "F024": { "api": 8801, "web": 3001, "claimedAt": "2026-04-19T..." },
  "F021": { "api": 8802, "web": 3002, "claimedAt": "..." }
}
```

- 新 worktree 启动脚本读注册表，分配最小未用端口
- 销毁 worktree 时脚本从注册表摘除
- 默认端口段：API 8800-8899，Web 3100-3199（避开 dev 主机）

---

## 5. 启动脚本形态（草图，待讨论）

```bash
# scripts/worktree-preview.sh <worktree-name>
# 1. 从 .worktree-ports.json 分配端口（或读已有）
# 2. mkdir -p <worktree>/.runtime/{data,uploads,runtime-events}
# 3. export API_PORT=... NEXT_PUBLIC_API_HTTP_URL=... SQLITE_PATH=... UPLOADS_DIR=...
# 4. 并行起 pnpm dev:api + pnpm dev:web
# 5. stdout 打印：
#    worktree <name> preview:
#      web: http://localhost:<web_port>
#      api: http://localhost:<api_port>
```

---

## 6. 未解问题（需讨论）

1. **端口注册表放哪层**：主仓 `.worktree-ports.json` vs worktree 内自声明？
2. **启动脚本归属包**：`scripts/` vs 新 package `@multi-agent/worktree-cli`？
3. **销毁钩子挂点**：`git worktree remove` 之前 or `worktree` skill 的 Close 环节？
4. **runtime-events 是否也要 env 化**：还是接受"worktree cwd 天然隔离"？（但会污染 worktree 内 docs/ 目录）
5. **MCP skills 挂载**：`mount-skills.sh` 是否写主仓？worktree 内跑时会不会污染主仓 `.claude/`？

---

## 7. P1 工作量初步评估

| 子任务 | 复杂度 | 依赖 |
|--------|--------|------|
| 抽 uploadsDir / runtimeEventsDir 为 env | S | 无 |
| 新建 `.worktree-ports.json` 注册表 + 端口分配脚本 | M | 需设计互斥写 |
| `worktree-preview.sh` 启动脚本 | M | 依赖注册表 |
| CLI stdout 端口提示 | S | 启动脚本内实现 |
| Dev 模式 env fail-fast 守卫 | S | web 组件不用改，启动脚本守卫即可 |
| AC 1.1-1.3 dogfooding 验证 | M | 所有上面的都完成后 |

**总估：P1 约 1-1.5 天（假设范德彪主力实现 + 黄仁勋 review）**。

---

## 8. 建议讨论的技术分歧点

### [分歧点] 端口注册表位置
- [A] 主仓 `.worktree-ports.json`（中心化、避免冲突、易审计）
- [B] worktree 内部 `.worktree-ports.local`（去中心化、不污染主仓）

### [分歧点] uploads / runtime-events 隔离策略
- [A] 完全 env 化（全路径可配）
- [B] 约定根目录（`<worktree>/.runtime/`），代码按规则拼路径（无需新 env）

---

## 9. 下一步

→ 黄仁勋 拉 范德彪 + 桂芬 做技术方案讨论（`collaborative-thinking`）
→ 收敛后进 `writing-plans` 产出 P1 任务分解
→ 小孙拍板后执行
