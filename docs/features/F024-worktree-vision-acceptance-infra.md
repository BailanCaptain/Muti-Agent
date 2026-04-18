---
id: F024
title: Worktree 愿景验收基础设施（L1 preview + L2 临时集成 worktree）
status: spec
owner: 黄仁勋
created: 2026-04-19
---

# F024 — Worktree 愿景验收基础设施

## Why

当前开发都在 worktree 进行，但**愿景验收必须推到 dev 才能看效果**——这让 worktree 的隔离价值在最后一步被自己抹掉，同时把 dev 的语义撕裂为"已验收主干"+"验收舞台"，必然污染。

**根因**：worktree 不具备独立 runtime 能力，验收对象（worktree 的 commit）与验收环境（dev 共享面）不同源。

**证据链**：
- `docs/discussions/2026-04-14-vision-guardian-infra.md:18` — 旧问题定性为"证据通道缺失 + 开发回路原始"
- F008 当时结论 `docs/features/F008-dev-infra-evidence-chain.md:76` — "先建证据链不上阻断"，第二步（环境隔离）留作未完成
- `multi-agent-skills/acceptance-guardian/SKILL.md:14` — 要求"零上下文"独立验收
- `multi-agent-skills/worktree/SKILL.md:16` — 要求隔离开发环境

F024 是 F008 第二步的落地。

## What

把愿景验收从 dev 迁出，做成两层同源验收架构：

**L1 · worktree preview**（单 feature 愿景验收舞台）
- 每个 worktree 启动时分配独立端口 + 独立数据目录（临时 SQLite / Redis / uploads）
- acceptance-guardian 路径强制绑定当前 worktree，证据/截图/日志不溢出主仓
- CLI 启动时输出端口提示（`worktree <name> preview: localhost:<port>`）

**L2 · 临时集成 worktree**（多 feature 协同愿景验收）
- 按 manifest 三元组（feature 列表 + commit SHA + 愿景版本）创建临时集成 worktree
- 一次性 · 按候选集生成 · 验完销毁，严禁退化为第二个 dev
- manifest 强校验（残缺即报错），命名强制 `staging/` 前缀

**配套规则改造**
- `acceptance-guardian/SKILL.md`：验收对象路径绑定当前 worktree
- `merge-gate/SKILL.md`：放行前校验 worktree-report / integration-report
- `multi-agent-skills/refs/shared-rules.md`：写入"验收环境同源原则 + L2 manifest 三元组"

**dev 语义归位**：只承载"已验收代码"，merge 后只做集成 smoke，不再"首次证明功能成立"。

## Acceptance Criteria

### L1 · worktree preview

- [ ] **AC-1.1** 端口自动隔离：同时启动 2 个 worktree，各自 curl 自己端口返回各自分支代码的响应，互不冲突
- [ ] **AC-1.2** 数据目录隔离：worktree A 创建一条记录，worktree B 与 dev 都看不到
- [ ] **AC-1.3** CLI 端口可见性：启动命令 stdout 包含 `worktree <name> preview: localhost:<port>`
- [ ] **AC-1.4** acceptance-guardian 路径绑定：在 worktree 内跑验收，所有证据/截图/日志落在 worktree 的 `.agents/` 下，不污染主仓
- [ ] **AC-1.5** dev 零污染：单 feature 走完 L1 验收 → merge 前后 diff dev 工作目录，除代码外无增量变化

### L2 · 临时集成 worktree

- [ ] **AC-2.1** 按 manifest 创建：脚本吃 manifest（feature + commit SHA + 愿景版本），产出可运行集成 worktree
- [ ] **AC-2.2** manifest 强校验：残缺 manifest 立即报错退出，绝不创建环境
- [ ] **AC-2.3** 即用即毁：命名前缀 `staging/`；销毁脚本跑完后 `git worktree list` 无残留、数据目录无残留
- [ ] **AC-2.4** 可追溯：每份 L2 报告自带 manifest 三元组，能还原"当时验的是谁/哪个 commit/哪版愿景"

### Meta · Dogfooding 自举（硬门禁）

- [ ] **AC-M.1** 本 feature 自己的 AC 必须用 **L1 本身**验收：在 F024 自己的 worktree 里起 preview → 跑 acceptance-guardian → 产出 worktree-report ✅
- [ ] **AC-M.2** L2 实战演示：挑两个在途 feature（优先 F021 + F022），用 L2 搭临时集成面完整跑一次愿景体验验收流程
- [ ] **AC-M.3** 规则同步闭环：shared-rules.md、acceptance-guardian/SKILL.md、merge-gate/SKILL.md 三处改动完成后，reviewer 能按新规则直接跑

## Dependencies

- **前置**：Phase 0 调研 packages/api + web 启动链路是否支持端口/数据目录参数化
- **松耦合**：F021 / F022（L2 实战演示的候选集）
- **不阻塞**：现有 feature 开发继续按旧流程推 dev 验收，F024 上线后切换

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 多 feature 协同验收放在哪 | [A] 只靠 merge 后 dev smoke / [B] 加临时集成 worktree | **B** | merge 后才发现耦合问题回退代价高；必须在进 dev 前暴露 |
| 临时集成面形态 | [A] 长期 staging 分支 / [B] 一次性 worktree | **B** | 长期分支会退化为第二个 dev，破坏同源原则（范德彪护栏） |
| 愿景定义存储 | [A] 主仓中心化 / [B] worktree 去中心化 | **A** | worktree 漂移违反 shared-rules.md 单一真相源铁律 |
| 候选环境落地方式 | [A] 每 worktree 自起 / [B] 统一 runner 按 commit 拉起 | **A** | 最符合 worktree 隔离语义，不易再退回共享 dev |
| 愿景看板 UI | [A] 本 feature 内做 / [B] 推后独立立项 | **B** | 解决"看得方便"非"验得正确"，优先级低于底层机制 |
| 验收环境生存周期 | [A] 即时销毁 / [B] worktree 存活期常驻 | **延后** | 工程取舍非路线分歧，实施时再定 |

## Phase 划分

| Phase | 任务 | 出口 |
|-------|------|------|
| **P0** | 前置调研：packages/api + web 启动是否支持端口/数据目录参数化 | 调研报告 |
| **P1** | L1 核心：端口隔离 + 数据目录隔离 + CLI 提示 | AC 1.1–1.3 通过 |
| **P2** | 规则改造：acceptance-guardian 路径绑定 + merge-gate 报告校验 | AC 1.4–1.5 通过 |
| **P3** | L2 核心：manifest 格式 + 创建/销毁脚本 | AC 2.1–2.4 通过 |
| **P4** | 家规落地：shared-rules.md 写入"同源原则 + L2 manifest 三元组" | AC M.3 通过 |
| **P5** | Dogfooding：L1 自验 L1，L2 拼 F021+F022 演示 | AC M.1–M.2 通过 |

## 风险与护栏

| 风险 | 应对 |
|------|------|
| L1 端口冲突 | `.worktree-ports` 注册表 + 自动避让 |
| 数据目录堆积 | worktree 销毁时自动清理钩子，写进 worktree skill |
| acceptance-guardian 历史逻辑回归 | 改 SKILL.md 前跑现有 feature 的验收 regression |
| L2 退化为"第二个 dev" | manifest 强校验 + `staging/` 前缀强制 + 销毁钩子 |
| Dogfooding 循环依赖（没 L1 怎么验 L1） | P5 允许手动辅助一次，之后所有迭代必须 L1 自验 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-19 | Kickoff（三方 collaborative-thinking 收敛后立项） |

## Links

- Discussion: `docs/discussions/2026-04-19-worktree-vision-acceptance.md`
- Plan: 待 writing-plans 阶段产出
- Related: F008（evolved from）、F021 / F022（L2 演示候选集）

## Evolution

- **Evolved from**: F008（补上 F008 "先证据链不上阻断" 留下的第二步 — 验收环境与待合入对象同源）
- **Blocks**: 无
- **Related**: F021、F022（将作为 L2 dogfooding 演示的候选集）
