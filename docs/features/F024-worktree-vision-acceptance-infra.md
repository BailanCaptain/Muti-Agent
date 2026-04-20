---
id: F024
title: Worktree 愿景验收基础设施（L1 preview + L2 临时集成 worktree）
status: done
owner: 黄仁勋
created: 2026-04-19
completed: 2026-04-20
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
- acceptance-guardian 路径强制绑定当前 worktree，证据/截图/日志落 worktree 本地（不进 git、不污染主仓 dev），但**主仓 agent 可通过文件系统路径读取**
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

- [x] **AC-1.1** 端口自动隔离：同时启动 2 个 worktree，各自 curl 自己端口返回各自分支代码的响应，互不冲突
- [x] **AC-1.2** 数据目录隔离：worktree A 创建一条记录，worktree B 与 dev 都看不到
- [x] **AC-1.3** CLI 端口可见性：启动命令 stdout 包含 `worktree <name> preview: localhost:<port>`
- [x] **AC-1.4** acceptance-guardian 路径绑定（严解 · 不进 git + 可跨 worktree 读）：
  - 所有证据（截图 / 日志 / 报告）落 `{current-worktree}/.agents/acceptance/{feature-id}/{timestamp}/`
  - `.agents/acceptance/` 加入主仓 `.gitignore` —— 证据**不进 git 历史**，merge 后 dev 不含归档
  - 主仓 agent 通过 `git worktree list` 按分支名匹配 feature-id → 拼上固定相对路径 `.agents/acceptance/{feature-id}/` 即可读取 worktree 内证据（文件系统层面无隔离）
  - worktree 被 `git worktree remove` 后证据随之消失 —— 接受这个代价；如需长期归档由人工显式操作（超出本 feature 范围）
- [x] **AC-1.5** dev 零污染：单 feature 走完 L1 验收 → merge 前后 diff dev 工作目录，除代码外无增量变化

### L2 · 临时集成 worktree

- [x] **AC-2.1** 按 manifest 创建：脚本吃 manifest（feature + commit SHA + 愿景版本），产出可运行集成 worktree（已实证：`staging/f022-f023-dogfood` + `staging/f024-selfcheck` 均由本脚本创建）
- [x] **AC-2.2** manifest 强校验：残缺 manifest 立即报错退出，绝不创建环境（7 个拒绝测试用例覆盖 stagingId / baseRef / visionVersion / features 空 / featureId 缺 / commitSha 缺 / features 非数组）
- [x] **AC-2.3** 即用即毁：命名前缀 `staging/`；销毁脚本跑完后 `git worktree list` 无残留、数据目录无残留（`f024-selfcheck` 一次 create + destroy 闭环实证：worktree / 目录 / 分支三者全灭）
- [x] **AC-2.4** 可追溯：每份 L2 报告自带 manifest 三元组，能还原"当时验的是谁/哪个 commit/哪版愿景"（`renderReportTemplate` 写入 stagingId / baseRef / visionVersion / features[featureId@commitSha]）

### Meta · Dogfooding 自举（硬门禁）

- [x] **AC-M.1** 本 feature 自己的 AC 必须用 **L1 本身**验收：在 F024 自己的 worktree 里起 preview → 跑 acceptance-guardian → 产出 worktree-report ✅
- [x] **AC-M.2** L2 实战演示：挑两个在途 feature（优先 F021 + F022），用 L2 搭临时集成面完整跑一次愿景体验验收流程
  - **等效证据（2026-04-20，小孙 CVO 拍板 B 路径打勾）**：`staging/f022-f023-dogfood` dogfood 已完成一次真实多 feature 拼装（F022-P1 + F023 Phase A）— 脚本走通、manifest 强校验生效、preview 起来了、抓到 F023 MCP 绝对路径 bug 并反向推动了 F023 Phase B 修复（B018 式联动闭环）。L2 infra 的全部价值主张（冲突检出 / 一次性即用即毁 / 报告三元组可追溯）由此次 dogfood 实证覆盖，AC-M.2 原教旨的"F021+F022 专项演示"变为冗余
  - 原计划失效前提：截至 2026-04-20 F020/F021/F022/F023 tip 全部已合 dev，桌面上不存在真正"在途未 merge"的两家 feature 可供专项拼装；若强行 cherry-pick 造假，违背 L2 设计初衷（真实冲突检出），反而污染证据链
  - 原始记录保留于 Timeline 2026-04-19/20 条目，后续遇到真并发场景时按此模式再跑一次自然覆盖
- [x] **AC-M.3** 规则同步闭环：shared-rules.md、acceptance-guardian/SKILL.md、merge-gate/SKILL.md 三处改动完成后，reviewer 能按新规则直接跑（commit `e3e1dd2` 落地；`worktree/SKILL.md` 同批同步）

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
| 验收证据归档策略 | [A] 随 feature 分支 commit 进 dev / [B] 只留 worktree 本地不进 git | **B** | dev 只承载"已验收代码"，归档入 git 会撕裂语义；主仓 agent 经 FS 跨 worktree 读取已够用（2026-04-19 小孙拍板） |

## Phase 划分

| Phase | 任务 | 出口 |
|-------|------|------|
| **P0** | 前置调研：packages/api + web 启动是否支持端口/数据目录参数化 | 调研报告 → [docs/plans/F024-phase0-startup-probe.md](../plans/F024-phase0-startup-probe.md) ✅ |
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
| 2026-04-19 | P0 调研完成：`docs/plans/F024-phase0-startup-probe.md` |
| 2026-04-19 | L1 dogfood 通过（黄仁勋 · 真环境双 worktree 并行 preview）：AC-1.1/1.2/1.3/1.4/1.5/M.1 全绿；报告 `.agents/acceptance/F024/2026-04-19/worktree-report.md`；**抓出 bug → 修复**：`app/layout.tsx` 补消费 `NEXT_PUBLIC_APP_TITLE_PREFIX` 让浏览器 title 前缀生效 |
| 2026-04-19 | L2 infra 自检通过（quality-gate）：`staging/f024-selfcheck` 合成 manifest 一次 create + destroy 闭环实证 AC-2.1/2.3/2.4；AC-2.2 由 7 个 parseStagingManifest 拒绝用例覆盖；AC-M.3 由 commit `e3e1dd2` 闭合。**L2 愿景体验验收（AC-M.2）blocked** on F023 MCP 配置绝对路径 bug（见 F023 Known Bug 小节） |
| 2026-04-19 | 范德彪 peer review 反馈 3 P1 修复（receiving-review）：(1) preview 覆写 `.env.development.local` → 改为 backup/restore；(2) `worktree-staging` 把 manifest 字段拼进 `execSync(string)` → 全部切 `execFileSync("git", [args])` + stagingId 字符白名单；(3) preview env 漏注 `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_API_BASE_URL` → 补注。port registry 无锁降级 P2 留 TODO 注释。全量 799/799 绿 |
| 2026-04-20 | 小孙产品信号"多 feature 并发是常态" → P2 升级为必修：port-registry 接入 `proper-lockfile`，claim/release 改 async + `withLock` 包住 read-modify-write。新增跨进程 race 测试（6 并发 tsx worker 同时 claim）：修复前抓到 3 条 8802 冲突（RED），修复后 6 个 worktree 拿到互斥端口（GREEN）。preview/staging 两处 caller 同步改 await |
| 2026-04-20 | 范德彪 re-review 抓到新 P1：`preview` 的 SIGINT/SIGTERM 处理器里 `void releasePorts().catch()` 后紧跟 `process.exit(0)`，Promise 没机会落盘 → `.worktree-ports.json` 残留僵尸 entry。修复：抽出 `shutdownPreview(): Promise<void>`（await release + restoreDotenv + killers），handler 改 `triggerShutdown().finally(() => exit(0))`。新增 2 个回归测：(1) 单元测 `shutdownPreview` 合同 — Promise resolve 时 registry 已空且 killers 已跑；(2) 端到端 child-worker — 子进程 `await shutdownPreview; exit(0)` 之后 parent 读 registry 必须为 0 条。实测翻 fire-and-forget 两测均 fail（RED），await 版本全绿（GREEN）。L0 33/33 绿 |
| 2026-04-20 | 范德彪 re-LGTM ✅。proactively 收掉 re-review 的 non-blocking 观察（signal handler 幂等性覆盖）：抽 `createShutdownController` 把 `triggerShutdown` 单例逻辑拎到可测试边界，+2 回归测覆盖 (1) 3 路 racing triggerShutdown 返回同一 Promise / killers 各跑 1 次 / registry 归零；(2) onSignal 链路 SIGINT+SIGTERM drains registry + exit spy 每次 code 0。Red 验过（非 memoize 版本 test 1 fail）。L0 35/35 绿；全量 821/821 绿（rebase origin/dev 后）。**AC-M.2 仍 blocked on F023** — 跨 feature 依赖，不在本 PR 范围 |
| 2026-04-20 | F024 merged to dev（squash `2f2e80f`）+ pushed origin/dev |
| 2026-04-20 | Completion — F023 Phase B 已 merge（`d1b516b`），小孙 CVO 拍板 B 路径：AC-M.2 以 `staging/f022-f023-dogfood` dogfood 为等效证据打勾（该次 dogfood 真实覆盖 L2 infra 全部价值主张且反向推动了 F023 bug 修复，等效强于造假 cherry-pick）。全 AC 绿，`staging/f022-f023-dogfood` worktree + 分支一并清理 |

## Follow-up TDs

- **TD-preview-backup-residue**：`scripts/worktree-preview.ts` 在异常退出（taskkill / Ctrl+C 硬杀 / 进程崩溃，signal handler 未跑完）时，`.env.development.local.backup-by-preview` 会残留在 worktree 内。正常 teardown 已由 `restoreDotenv` 恢复，但异常路径缺兜底。**发现**：2026-04-20 F023 merge-gate 清理时（小孙发现）。**短期对策**：`merge-gate` 5a（副产物清理）每次 merge 显式 `rm -f .env*.backup-by-preview`（已写入 skill）。**根治方案**：preview 启动时先扫并清历史 `*.backup-by-preview`（防御式）；注册 SIGINT/SIGTERM handler 保 `restoreDotenv` 跑完（已通过 F024 P3 部分覆盖，但需要复核覆盖完整性）。**影响**：根治后 `merge-gate` 5a 里 `.env*.backup-by-preview` 那行可删。

## Links

- Discussion: `docs/discussions/2026-04-19-worktree-vision-acceptance.md`
- Plan: `docs/plans/F024-worktree-vision-acceptance-plan.md`
- Phase 0 Report: `docs/plans/F024-phase0-startup-probe.md`
- Related: F008（evolved from）、F021 / F022（L2 演示候选集）

## Evolution

- **Evolved from**: F008（补上 F008 "先证据链不上阻断" 留下的第二步 — 验收环境与待合入对象同源）
- **Blocks**: 无
- **Related**: F021、F022（将作为 L2 dogfooding 演示的候选集）
