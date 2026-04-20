---
id: F023
title: 三家 MCP 挂载统一（对齐 clowder-ai）+ 弃 CALLBACK_API_PROMPT
status: done
owner: 黄仁勋
created: 2026-04-19
completed: 2026-04-20
---

# F023 — 三家 MCP 挂载统一 + 弃 CALLBACK_API_PROMPT

## Why

小孙在 2026-04-19 的 thread 里发现：他让黄仁勋调用 `take_screenshot` MCP 工具但调不出来。排查后发现整套 MCP 架构存在三个问题：

1. **Claude 的 MCP 从未在当前 runtime 下真正工作过**
   - `claude-runtime.ts:90` 从 commit `fbaf7f4b`（F003 "A2A初步"，2026-03-15）起就写的 `path.join(__dirname, "..", "mcp", "server.js")`
   - 这行只在"从 dist 跑 + dist/mcp/server.js 已编译"前提下正确；我们 runtime 是 tsx 直跑 src → 推出 `src/mcp/server.js`（永远不存在的文件）
   - 所以 Claude 每次拉起，`--mcp-config` 指的 MCP server 都 spawn 失败，工具列表里从来没有 `mcp__multi_agent_room__*`

2. **Codex/Gemini 根本没挂 MCP，只有 `CALLBACK_API_PROMPT` 教手工 curl**
   - `agent-prompts.ts:93-119` 塞了一段"告诉 agent 用 `node -e fetch(...)` 调 HTTP callback"的指引
   - 结果：Codex/Gemini 永远触达不到 `take_screenshot`/`request_decision`/`parallel_think` 等 MCP 专属工具；而 F018 注册的 `recall_similar_context`、F019 注册的 `update_workflow_sop` 对三家全员都是摆设

3. **临时文件副作用**
   - `claude-runtime.ts:107-113` 每次 `mkdtemp` 一个 `/tmp/multi-agent-mcp-*/`，实测已堆积**几百个**（从 2026-04-15 到 2026-04-17，跨天数百次 room 启动的残骸）

### 小孙原话（立项依据，不可删）

> 那为什么你调用不了截图MCP？？

> 什么意思 我没懂 你不是我通过进程拉起来的吗？？

> 算了 我觉得我们统一MCP吧 三家都统一，别照葫芦画瓢了，我们就挂载在项目路径下

> 不维持了 我想用三家的官方那一套，临时的这种--mcp-config,Gemini、codex的prompt注入这种我想都删掉

> 谁说不支持 我建议你看一下 clowder-ai的代码

> 1、先排查下src/mcp/server.js 不存在 这个错误是什么引入的 2、 CALLBACK_API_PROMPT 不降级直接删掉

### clowder-ai 已验证的模式（我们照搬）

参照 `C:\Users\-\Desktop\cafe\clowder-ai`：
- 项目根 `.mcp.json`（Claude 自动挂）
- 项目根 `.codex/config.toml`（Codex CLI 启动自动读项目根——官方行为，非 `-c` 覆盖）
- 项目根 `.gemini/settings.json`（Gemini 自动挂）
- 三份同构定义一组 MCP server，**不写 env**；动态 token 靠 runtime spawn CLI 时 `env: {...MULTI_AGENT_*}` 进程继承链传到 MCP server 子进程

### Phase B 追加 Why（2026-04-20 考察 clowder-ai F145 + 本项目实测调研）

Phase A（Task 1-6，已 6 commits 进 F023 worktree）写完三家配置后，F024 staging 实跑仍暴露 MCP 挂不上。2026-04-20 考察 **clowder-ai F145 "MCP Portable Provisioning"** + 对本项目 runtime 实测调研，修正 Phase A 遗留的两个假设，确定 A 方案（务实按根因走，不为架构对齐做不对症的改造）。

**根因 A — runtime spawn 未传 cwd（确定）**

`packages/api/src/runtime/base-runtime.ts:258` 走 `spawn(command, args, { cwd: input.cwd, ... })`，但 `cli-orchestrator.ts:119-134` 构建 `AgentRunInput` 时**没给 cwd 赋值**。结果三家 CLI spawn 时 cwd 降级到 Node 进程的 `process.cwd()` = `dev:api` 启动时所在目录 = **主仓根**。

worktree preview / staging 场景下，相对路径 `packages/api/dist/mcp/server.js` 一律被解析到主仓 dist，worktree 自己的 MCP server 改动永远不被加载。F024 staging "碰巧通过"是主仓 dist 恰好新鲜。**Phase A Known Bug 小节"相对路径已够"的结论由此勘误：相对路径方向对但不够，必须同时让 runtime 显式传 projectRoot 作 cwd**。

**根因 B — Gemini 挂不上 MCP（未知，需 Spike）**

初步考察假设 Gemini 走 ACP 协议不读 `.gemini/settings.json`。**实测推翻**：`gemini-runtime.ts:88-116` 是纯 CLI spawn，`.gemini/settings.json` 理应生效。但 F024 staging 桂芬实测 MCP 仍挂不上。候选根因：
- `env: {VAR: "${VAR}"}` 插值在当前 Gemini CLI 版本未生效
- settings.json 位置错（项目级 vs `~/.gemini/settings.json`）
- 根因 A 的次生症状（cwd 错 → Gemini 读不到项目级 settings.json）

Phase B 需 Spike — 实跑桂芬拿 stderr/启动日志定位，再做针对性修复。

**根因 C — Codex 挂不上 MCP（未知，需 Spike）**

与根因 B 同构：`.codex/config.toml` 已就位、`codex-runtime.ts` 是纯 CLI spawn 理应生效，但小孙报告"德彪不回复"。需 Spike 定位：启动失败 / 挂上但不调用 / 还是 cwd 次生问题。

**Phase D 防御（零成本前瞻）**

clowder-ai F145 Phase D 说 `~/.claude.json.projects[projectRoot].mcpServers` 优先级 > `.mcp.json`。本项目实测 `projects["C:/.../Multi-Agent"].mcpServers = {}` 为空，**当前不构成遮蔽**（非根因）。但 worktree 被 Claude Code 识别后可能写入 stale entry。加一段写完 `.mcp.json` 后清理 per-project override 的防御逻辑，零成本前瞻。

## What

**核心变更**：
1. 修 `claude-runtime.ts` MCP server 路径 bug：产出稳定的 `packages/api/dist/mcp/server.js`，三家配置文件统一指向 dist
2. 新增三份项目级 MCP 配置文件（`.mcp.json` / `.codex/config.toml` / `.gemini/settings.json`）
3. 删除 `claude-runtime.ts` 里 `--mcp-config` 临时 JSON / `mkdtemp` / cleanup 整套（92-116 行）
4. 删除 `CALLBACK_API_PROMPT` 常量 + 两处 codex/gemini 拼接 + `agent-prompts.test.ts` 两个 `Callback API` 断言

**用户能感知到的变化**：
- Codex 和 Gemini 真的能调用 `take_screenshot` / `request_decision` / `parallel_think` / `update_workflow_sop` / `recall_similar_context` 等 MCP 工具（不再被迫写 `node -e fetch` 指令）
- Claude 的 MCP 工具列表里出现 `mcp__multi_agent_room__*`（当前是假的，工具从未挂上过）
- `/tmp/multi-agent-mcp-*` 临时目录不再增长

**用户感知不到但内部清理**：
- 三家 runtime 启动命令更短（少了 `--mcp-config` 一长串参数）
- system prompt 瘦身（Codex/Gemini 少约 27 行 `CALLBACK_API_PROMPT`）

## Acceptance Criteria

- [x] AC1: Claude runtime 在 room 启动后，工具列表包含 `mcp__multi_agent_room__take_screenshot` 等 MCP 工具（可通过任何一个 Claude 会话调用截图验证）
- [x] AC2: Codex runtime 在 room 启动后，能直接调用 MCP 工具（通过 `.codex/config.toml` 项目级配置挂载，无需产品 runtime 注入 `-c`）
- [x] AC3: Gemini runtime 在 room 启动后，能直接调用 MCP 工具（通过 `.gemini/settings.json` 项目级配置）
- [x] AC4: `packages/api/dist/mcp/server.js` 产物存在并由 build 流程保证与 `src/mcp/server.ts` 同步（新增或更新构建脚本）
- [x] AC5: `claude-runtime.ts` 中 `mkdtemp` / `writeFileSync(mcp-config.json)` / `--mcp-config` 逻辑全部删除，不再产生 `/tmp/multi-agent-mcp-*` 目录
- [x] AC6: 全项目源码（`packages/api/src/**`）grep `CALLBACK_API_PROMPT` 和 `Callback API` 都零匹配（docs 历史文档不动）
- [x] AC7: `agent-prompts.test.ts` 中两处 `includes("Callback API")` 断言删除或重写，pnpm test 全绿
- [x] AC8: 实际跑一次三家联动验证——Codex 或 Gemini 通过 MCP 调一次 `post_message` 或 `take_screenshot`，前端能看到正确结果

### Phase B 追加 AC（2026-04-20 扩 scope）

- [x] AC9（根因 A 修复）: runtime spawn CLI 时 cwd 显式传当前 invocation 的 `projectRoot`（worktree 场景 = worktree 根，主仓场景 = 主仓根）。`AgentRunInput` 类型补 cwd 字段，`cli-orchestrator` 构建时必填，`base-runtime.spawn` 透传。单元测试断言：AgentRunInput 必带 cwd；spawn 接收到与输入相同的 cwd
- [x] AC10（根因 B Spike + 修复）: Gemini 在 F023 worktree（或 F024 preview）启动后，MCP 工具列表包含 `mcp__multi_agent_room__*` tools。产出 Spike 报告（stderr/启动日志定位根因）+ 针对性修复 + 回归测试 — *功能达标（2152c1a NDJSON 传输层修复根因）；Spike 过程走 commit message，未落独立文档*
- [x] AC11（根因 C Spike + 修复）: Codex 在 F023 worktree（或 F024 preview）启动后，MCP 工具列表包含 `mcp__multi_agent_room__*` tools。产出 Spike 报告 + 针对性修复 + 回归测试 — *功能达标（f92a892 `env_vars` 白名单 + 2152c1a NDJSON）；Spike 过程同 AC10*
- [x] AC12（worktree 同源验证）: 在 F023 worktree 的 `packages/api/src/mcp/server.ts` 加一个 stub tool（例：`_f023_probe`），build worktree dist 后，在**该 worktree** 启动的 CLI 会话能列出 `_f023_probe`；同时主仓启动的 CLI **不**出现该 tool。验证完删除 stub — *未用 stub 探针；9afc8de 相对路径 + 8efbca4 runtime cwd 必填组合等价同源，小孙 worktree 实跑验收通过即事实同源*
- [ ] AC13（Phase D 防御）: runtime 在 room 启动流程里清理 `~/.claude.json.projects[projectRoot].mcpServers` 中 `multi_agent_room` 这一项（不动其他项、不动 global `mcpServers`）。单元测试覆盖：有 stale entry → 删；无 entry → no-op；其他 server 名 → 保留 — **未实现，小孙 CVO 授权作为已知 TD 跳过合入**（当前实测 stale entry 为空 `{}` 不 blocking；前瞻防御单独立项）

## Dependencies

- 无前置 feature 依赖
- 依赖条件：
  - `packages/api/src/mcp/server.ts` 已实现且 `getCallbackIdentity()` 从 `process.env.MULTI_AGENT_*` 读 token（已就绪，2026-03-15 起一直如此）
  - runtime spawn CLI 时已将 `MULTI_AGENT_*` env 写入子进程 env（已就绪，`base-runtime.ts` 继承链）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| MCP server 产物形式 | [a] dist JS 入构建流程 / [b] tsx 直跑 src.ts | **[a]** | 对齐 clowder-ai（`packages/mcp-server/dist/*.js`）；启动零依赖、冷启动快；不依赖 tsx/pnpm 环境 |
| Codex 项目级配置落位 | 项目根 `.codex/config.toml` / 用户级 `~/.codex/config.toml` / runtime `-c` 覆盖 | **项目根 `.codex/config.toml`** | clowder-ai 已实际验证 Codex CLI 启动时自动读项目根配置（官方隐式约定）；零污染用户级、零动态注入 |
| CALLBACK_API_PROMPT 处置 | 降级 fallback（MCP 不可用才注入）/ 直接删除 | **直接删除** | 小孙 2026-04-19 明确"不降级直接删掉"；MCP 统一挂载后无降级必要 |
| 配置文件 env 字段 | 写 `env: {MULTI_AGENT_*: "..."}` 静态值 / 不写 env | **不写 env** | 动态 token 靠进程继承；静态值无法表达每次 invocation 不同的 token；对齐 clowder-ai `.mcp.json`/`.codex/config.toml` 无 env 字段的做法 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-19 | Kickoff |
| 2026-04-19 | Post-kickoff bug 发现（见下）|
| 2026-04-20 | Phase A 复盘：F024 staging 实跑三家 MCP 仍挂不上 → 考察 clowder-ai F145 + 本项目 runtime 调研 → 小孙拍板 A 方案扩 scope（根因 A 修 cwd + Spike 根因 B/C + Phase D 防御），追加 AC9–AC13 |
| 2026-04-20 | Phase B 实施完成（commits `008d2ff` → `9f40784`）：根因 A cwd 修复、NDJSON 传输层、Codex env_vars 白名单、相对路径 hotfix、截图 URL 绝对化；AC1–AC12 全部达成（AC10–AC12 见 AC 注释），AC13 作为 TD 跳过 |
| 2026-04-20 | 小孙（CVO）在 F023 worktree 亲自做 L1 验收 — 截图显示通过、三家 MCP 可用；授权跳过独立 acceptance-guardian（thread 原话：「验收时我验收的 你把文档更新好就行了」）；`.agents/acceptance/F023/2026-04-20/worktree-report.md` 本地留痕 |
| 2026-04-20 | Completion — `d1b516b` squash 已含 Phase A+B 全部修复（相对路径 + cwd + NDJSON + env_vars 白名单）；dev 上 `.mcp.json` / `.codex/config.toml` / `.gemini/settings.json` 就位；AC1–AC12 全绿，AC13（Phase D 防御）小孙授权作为 TD 跳过；文档闭环 |

## Known Bug — MCP 配置写入绝对路径（2026-04-19 发现，F024 staging 验收暴露）

### 现象

F024（worktree 愿景验收基础设施）在 staging 分支 `staging/f022-f023-dogfood` 拉起桂芬（Gemini）做联动验证时，Gemini 启动后 MCP 工具列表**仍然为空**，调不到 `take_screenshot` 等工具。

### 根因

F023 提交的三份项目级 MCP 配置，`args` 里全部是**硬编码的主工作目录绝对路径**：

| 文件 | 当前写法 |
|------|----------|
| `.mcp.json` | `"C:/Users/-/Desktop/Multi-Agent/packages/api/dist/mcp/server.js"` |
| `.codex/config.toml` | `"C:\\Users\\-\\Desktop\\Multi-Agent\\packages\\api\\dist\\mcp\\server.js"` |
| `.gemini/settings.json` | `"C:\\Users\\-\\Desktop\\Multi-Agent\\packages\\api\\dist\\mcp\\server.js"` |

这会引发两类问题：

1. **worktree preview 下路径错配**：F024 在 `C:/Users/-/Desktop/multi-agent-<feature>/` 下跑 CLI，但 MCP 配置把 server.js 钉死在主工作目录 — worktree 自己的 `packages/api/dist/mcp/server.js`（包含该 feature 的改动）**永远不会被加载**，每个 worktree 的 MCP 行为都等价于主目录的当前 dist。
2. **提交机器特定路径，不可移植**：任何 clone 到其他机器 / 其他用户目录的人拿到的配置都是坏的；团队协作中等于没写。

### 修复方向（B 方案，2026-04-19 与小孙拍板）

把三份配置里的绝对路径改为**相对于项目根的相对路径**：`packages/api/dist/mcp/server.js`。三家 CLI 启动时 cwd = 项目根（clowder-ai 已验证这个约定），相对路径天然跟随 worktree 走。

- **TDD 补强**：`tests/integration/mcp-config.test.ts` 增加断言"三份配置的 `args[0]` 不得以 `C:` 或 `/` 开头（即不得是绝对路径）"，防止回归。
- **不降级、不做环境变量插值**：clowder-ai 验证过相对路径直接可用，就按最简做法。

### 影响面

- AC2（Codex）/ AC3（Gemini）/ AC8（三家联动）在 worktree / 异机环境下**实际未达标**（staging 单机恰好主目录就是钉死路径所以碰巧通过了 — 这是假通过）
- F024 愿景验收被此 bug blocking，需要本修复 merge 后才能重跑

### 处置

- **不起独立 B018 ticket**（小孙 2026-04-19 决策：在 F023 文档内记录即可）
- 本修复作为 F023 的 scope 内补丁，与 F023 主干一起 merge
- F024 验收待本修复 merge 后恢复

### 2026-04-20 勘误 — 相对路径也不够（F145 考察 + 本项目调研暴露）

Phase A hotfix 把绝对路径改成相对路径后，F024 staging 复跑仍失败。**根因**：runtime spawn CLI 时 cwd 未显式传 projectRoot（`cli-orchestrator.ts:119-134` 构建 `AgentRunInput` 没赋值 cwd），相对路径被解析到 `process.cwd()` = 主仓根，worktree 自己的 dist 永远不被加载。

**方向对但只做了一半**：相对路径本身不回退（正确），但必须同时让 runtime spawn 显式传当前 invocation 的 projectRoot 作 cwd。该修复并入 Phase B 根因 A（见 Phase B 追加 Why + AC9）。

## Links

- Discussion: 2026-04-19 本次 thread（排查 MCP 无法调用 → clowder-ai 代码对照 → 统一方案决策）
- Reference: `C:\Users\-\Desktop\cafe\clowder-ai\.mcp.json` / `.codex/config.toml` / `.gemini/settings.json` + `packages/api/src/utils/cli-spawn.ts` + `packages/api/src/domains/cats/services/agents/invocation/McpPromptInjector.ts`
- Related: F003 / F018 / F019

## Evolution

- **Evolved from**: F003（A2A 运行时闭环，2026-04-11 完成）— commit `fbaf7f4b` "A2A初步" 首次引入 `--mcp-config` 临时方案 + `CALLBACK_API_PROMPT` curl 教学，本 feature 收尾并替换为三家 CLI 官方项目级 MCP
- **Blocks**: 无
- **Related**:
  - F018（注册 `recall_similar_context` MCP 工具）— 本 feature 完成后，Codex/Gemini 才真正能用该工具
  - F019（注册 `update_workflow_sop` MCP 工具）— 本 feature 完成后，Claude 才真正能用该工具（此前因 server.js 路径 bug spawn 失败）
