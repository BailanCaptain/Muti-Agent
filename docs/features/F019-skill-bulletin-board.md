---
id: F019
title: Skill 告示牌机制 — WorkflowSop 状态机替换关键词注入层
status: in-progress
owner: 黄仁勋
created: 2026-04-17
---

# F019 — Skill 告示牌机制：WorkflowSop 状态机替换关键词注入层

**Created**: 2026-04-17
**Priority**: P0

## Why

**症状**：2026-04-16 讨论"右侧智能体配置栏优化"时（thread `ed07362a-…`），小孙 @ 三人 "讨论一下"，三个 agent 都没加载 `collaborative-thinking` SKILL.md，讨论停在 Phase 1 独白，Mode C 收敛三件套（ADR/lessons/指引）完全没触发。DB 核实三份 `tool_events` 均无 SKILL.md 读取记录。

**根因**：我们相对 clowder-ai 多加了一层 `SkillRegistry.match()` + `prependSkillHint`——关键词扫描 + 强制 hint 注入。这一层在 Mode B 独立思考场景与"不加载 SKILL.md 全文"规则**本质冲突**（`packages/api/src/services/message-service.ts:69-73` 代码注释已承认是 regression），只能在 Mode B 分支局部关闭 hint，关闭后 Phase 2~6 + Mode C 失去 skill 引导。

**clowder-ai 的做法（F073 P4）**：告示牌哲学——`WorkflowSop` 状态机持久化 feature 阶段，`sopStageHint` 一行注入 system prompt，猫看了自己决定行动。不扫关键词、不强制加载。参考 `reference-code/clowder-ai/packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts:591-596`。

**顺带发现的基建 drift**：`.agents/skills/` 和 `.gemini/skills/` 有 3 个 dangling symlink（`ask-dont-guess` / `hardline-review` / `merge-approval-gate`），指向已删除的 skill 目录。`.claude/skills/` 已清理，另两处没跟上。三挂载点无同步机制，"manifest 单一真相源"名存实亡。

## What

1. 新增 `WorkflowSopService` 状态机（stage 枚举 + batonHolder + resumeCapsule + checks）+ SQLite 持久化
2. `agent-prompts.ts` 每次 invocation 注入一行 `SOP: {feat} stage={stage} → load skill: {skill}`
3. 新增 `POST /api/callbacks/update-workflow-sop` 推进入口 + 对等 MCP tool（Claude 走 MCP，Codex/Gemini 走 HTTP fallback）
4. 补全 `manifest.yaml` 的 `sop_navigation`（加 `hard_rules` / `pitfalls` 字段，对标 clowder-ai）
5. 写 `multi-agent-skills/BOOTSTRAP.md` —— 压缩选择表 + `<EXTREMELY_IMPORTANT>` 合规钳 + 三 CLI 加载方式说明
6. 写 `scripts/sync-skill-mounts.sh` 以 manifest 为源同步 `.claude/` `.agents/` `.gemini/` 三挂载点，清理 dangling link；挂到 `pnpm check`
7. 砍 `prependSkillHint` / `buildSkillHintLine`（保留 `phase1-header.ts`，那是路由策略不是 skill 注入）

## Acceptance Criteria

- [x] AC1: `WorkflowSopService` 持久化到 SQLite，stage 枚举覆盖 `kickoff | impl | quality_gate | review | merge | completion` 六阶段；版本号 + 乐观锁防并发写丢失
- [x] AC2: 每次 CLI invocation 的 system prompt 包含 `sopStageHint` 一行（当 thread 关联到 feature 时）；无 feature 绑定时不注入
- [x] AC3: Agent 可通过 MCP tool `update_workflow_sop` 或 HTTP callback `/api/callbacks/update-workflow-sop` 主动推进 stage，DB 写入成功即视为推进；两路径行为一致
- [x] AC4: `multi-agent-skills/BOOTSTRAP.md` 存在，包含 15 个 skill 的压缩表（skill 名 / 触发场景 / SOP step）+ 三 CLI 加载方式说明 + `<EXTREMELY_IMPORTANT>` 段
- [x] AC5: `scripts/sync-skill-mounts.sh`（或 `pnpm run sync-skills`）运行后，`.claude/` `.agents/` `.gemini/` 三挂载点 symlink 与 `manifest.yaml` 一致，零 dangling link；`pnpm check` 中加入校验，drift 时 exit 1
- [x] AC6: `prependSkillHint` / `buildSkillHintLine` / `matchOrthogonalSkills` 被删除，`message-service.ts:69-73` 的历史注释同步清理；`message-service-skill-hint.test.ts` 重写或删除（P4 merged）
- [x] AC7: 系统侧传输保证 — `phase1HeaderText` → assembled content（`context-assembler.test.ts` 覆盖）+ `sopStageHint` → `MULTI_AGENT_SYSTEM_PROMPT`（`cli-orchestrator.sop-hint.test.ts` 覆盖 3 providers）。**agent 行为层**（SKILL.md 真加载 + Mode C 三件套触发）**留人工 smoke**
- [ ] AC8: 愿景对照三问全 ✅（本 feature 解决的是"agent 不加载该加载的 skill"）；独立验收守护 agent 输出证物对照表且全匹配 **(acceptance-guardian 独立验收待跑)**

## Dependencies

- 无硬阻塞依赖
- 与 F003 的 `next_dispatch` 并存（告示牌是"当前阶段"，next_dispatch 是"skill 完成后去哪"，层级不同）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 路径选型 | A) 砍 prependSkillHint 回归 clowder-ai 告示牌 / B) 保留 hint 层补全 Mode B 阶段 / C) 仅文档 | **A** | 小孙拍板（2026-04-17）；B 承认架构债并长期维护，C 不解决问题 |
| 持久化 | SQLite / Redis / 内存 | **SQLite** | 我们主存已是 SQLite；clowder-ai 用 Redis 是因主存就是 Redis |
| BOOTSTRAP.md 是否必要 | 必要 / 不必要 | **必要** | CLI discovery 不做三件事：(a) 压缩选择表 (b) 合规钳 `<EXTREMELY_IMPORTANT>` (c) 三 CLI 加载方式说明 |
| sync-skill-mounts 时机 | 每次 commit / 手动 / pre-commit hook | **pnpm check 校验 + 手动执行；pre-commit 作为 follow-up** | 先保证校验 + 可执行，自动化 hook 可作为后续增强 |
| 三挂载点是否砍剩一家 | 保留三家 / 只保留 .claude/ | **保留三家** | 三 CLI 都有项目级 discovery，砍掉会丢 Codex/Gemini 能力 |
| L6 IntentParser (`#ideate` / `#execute`) | 纳入 / 不纳入 | **不纳入本 feat** | 独立 enhancement，与告示牌正交；当前 @人数隐式判断够用（2026-04-17 小孙倾向） |
| AC7 重放验证方式 | 人工构造一次 / 自动化测试 / 两个都做 | **两个都做** | 自动化回归更稳，上线前人工跑一次烟雾测试 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-17 | Kickoff，已做 self-evolution 讨论（本 thread），选定方案 A |
| 2026-04-17 | P1-P3 merged to dev (539efa8) — AC1-AC5 完成，Codex adversarial review 三轮闭环 APPROVED。P4（砍 prependSkillHint + AC6/AC7/AC8）独立分支 |
| 2026-04-17 | P4 merged to dev (5a288aa) — AC6 + AC7 系统侧完成。Codex adversarial review 两轮闭环 APPROVED（round-1 提 2 findings 全修，round-2 no material findings）。AC7 agent 行为 + AC8 acceptance-guardian 待跑 |

## Phases

| Phase | 内容 | 工作量 | 产出 |
|-------|------|-------|------|
| P1 | L1-fix (sync-skill-mounts) + L1' (BOOTSTRAP.md) + L4 (manifest sop_navigation 补 `hard_rules` / `pitfalls`) | 1.5~2d | 基建清理 + 静态文档完整 |
| P2 | L2 (WorkflowSopService + SQLite + stage 枚举 + 单元测试) | 2~3d | 告示牌引擎 |
| P3 | L3 (sopStageHint 注入到 agent-prompts) + L5 (update-workflow-sop callback + MCP tool) | 1.5d | 告示牌展示 + 推进入口 |
| P4 | 砍 prependSkillHint / buildSkillHintLine + 回归验证（含 AC7 重放、跨 agent 交叉验证） | 1d | 老层清理 + 愿景对照 |
| **合计** | | **6~8d** | |

## Links

- Discussion: 本 thread（`ed07362a-…` 之后的 self-evolution 讨论 2026-04-17）
- Plan: [`docs/plans/F019-skill-bulletin-board-plan.md`](../plans/F019-skill-bulletin-board-plan.md) — P1~P4 分步实施计划
- Related: F003（SOP 回程派发）· F018（clowder-ai 基建对齐模式）
- References:
  - `reference-code/clowder-ai/packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts:591-596`（sopStageHint 注入样例）
  - `reference-code/clowder-ai/packages/shared/src/types/workflow-sop.ts`（状态机类型）
  - `reference-code/clowder-ai/cat-cafe-skills/BOOTSTRAP.md`（BOOTSTRAP 对标）
  - `reference-code/clowder-ai/cat-cafe-skills/manifest.yaml:661-703`（sop_navigation 样例）
  - `packages/api/src/services/message-service.ts:69-73`（本项目自承认的 regression 注释）
  - `packages/api/src/services/message-service.ts:1796-1800`（Mode B 分支被迫跳过 prependSkillHint 的注释）

## Evolution

- **Evolved from**: 无（新独立需求）
- **Blocks**: 无
- **Related**: F003（SOP 派发链），F018（clowder-ai 对齐模式）
