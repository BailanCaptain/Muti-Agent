---
id: F023
title: 三家 MCP 挂载统一（对齐 clowder-ai）+ 弃 CALLBACK_API_PROMPT
status: spec
owner: 黄仁勋
created: 2026-04-19
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

- [ ] AC1: Claude runtime 在 room 启动后，工具列表包含 `mcp__multi_agent_room__take_screenshot` 等 MCP 工具（可通过任何一个 Claude 会话调用截图验证）
- [ ] AC2: Codex runtime 在 room 启动后，能直接调用 MCP 工具（通过 `.codex/config.toml` 项目级配置挂载，无需产品 runtime 注入 `-c`）
- [ ] AC3: Gemini runtime 在 room 启动后，能直接调用 MCP 工具（通过 `.gemini/settings.json` 项目级配置）
- [ ] AC4: `packages/api/dist/mcp/server.js` 产物存在并由 build 流程保证与 `src/mcp/server.ts` 同步（新增或更新构建脚本）
- [ ] AC5: `claude-runtime.ts` 中 `mkdtemp` / `writeFileSync(mcp-config.json)` / `--mcp-config` 逻辑全部删除，不再产生 `/tmp/multi-agent-mcp-*` 目录
- [ ] AC6: 全项目源码（`packages/api/src/**`）grep `CALLBACK_API_PROMPT` 和 `Callback API` 都零匹配（docs 历史文档不动）
- [ ] AC7: `agent-prompts.test.ts` 中两处 `includes("Callback API")` 断言删除或重写，pnpm test 全绿
- [ ] AC8: 实际跑一次三家联动验证——Codex 或 Gemini 通过 MCP 调一次 `post_message` 或 `take_screenshot`，前端能看到正确结果

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
