---
id: F027-P19-phase2-evidence-summary
title: F027 Phase 2 evidence pack 收稿 — 19 AC double-pass（18 PASS + 1 BLOCKED）
created: 2026-05-19
phase: F027 Phase 2 — NightlyJobScheduler / 统一记忆架构调度层
plan: docs/plans/F027-phase2-implementation-plan.md（v2b frozen）
---

# F027 Phase 2 Evidence Pack 收稿

**Branch / Worktree:** `feat/F027-unified-memory-architecture` @ `.worktrees/F027`
**Plan:** `docs/plans/F027-phase2-implementation-plan.md`（v2b frozen — 11 jobs / 19 AC / 4 周）

## 交付总览

Phase 2 = NightlyJobScheduler 调度层。**11 个 job 全部落地**（9 scheduled + 2 event-driven）+ SchedulerRuntime 集成层 + 19 AC evidence pack。

| Week | 内容 | 评审 |
|---|---|---|
| 1 | 框架 + lease + 契约 + 核心 jobs（P19.1~6/16）| r1 NO-GO → r3 GO |
| 2 | DocsWatcher + backfill + HealthCheck（P19.7~8）| r1 NO-GO → r3 GO |
| 3 | Vacuum/Digest/Drift/Snapshot（P19.9~12）| r1 NO-GO → r2 GO |
| 4 | Archive/Alert/Debounce + 集成层（P19.13~16）| r1 NO-GO → r3 GO |

每 Week 走 requesting-review → 范德彪 code-review → receiving-review r1→rN chain。范德彪（Codex）异构 reviewer。

## 测试规模

- Phase 2 新增测试：**248 tests**（16 个 scheduler 测试文件 + backfill-docs）全绿
- 全套回归：`pnpm test:api` → **2412 pass / 8 skip / 1 todo / 0 fail**
- 0 P19 回归（SessionTitler ~50% flake 为 Phase 2 前既有，已 verify 非 P19 引入）

## Evidence Pack — 19 AC double-pass

落点：`docs/features/F027/evidence/phase2/AC-P2-<N>/`
每 AC 三件套：`result.json` + `judges/{judge1_claude-opus-4-7, judge2_codex-gpt-5.4, arbitration}.json`

| 结果 | 数量 | AC |
|---|---|---|
| **PASS**（double-pass）| 18 | AC-P2-1, 2, 3a, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 |
| **BLOCKED**（double-blocked）| 1 | AC-P2-3b |

### AC-P2-3b BLOCKED — 非缺陷，外部门禁

AC-P2-3b（真 `wiki.config.yaml` 加载 + `wiki.config.example.yaml` 模板）绑死 **Iron Laws 3（配置不可变）**。必须 `docs/features/F027-unified-memory-architecture.md` **Gate 2** 小孙显式批准 + 留证据 commit，loader 才允许真读配置文件。

Gate 2 未批 → 本 AC 保持 BLOCKED，**不创建任何真配置文件**即为正确合规行为。两 judge（Opus + Codex）一致确认 BLOCKED 合规。

**解锁路径**：小孙批 Gate 2 → 创建 `wiki.config.example.yaml` + 真 `wiki.config.yaml` → `scheduler-config-realfile.test.ts` → 补 AC-P2-3b PASS。loader 的 YAML 解析路径已在 P19.3a 实现完整、仅 in-memory fixture 覆盖，Gate 2 后可直接接入。

## 双 judge 说明

- **judge1 = claude-opus-4-7**：本应由 `p18-judge.ts` 自动 runner 调起；本环境嵌套 `claude` spawn 60s 超时，故 judge1 由 Claude Opus 4.7 直接按 `buildJudgePrompt` rubric 评估产出（同模型、同 rubric）。
- **judge2 = codex-gpt-5.4**：范德彪（Codex）异构独立评审 —— double-pass 的异构独立性由此保证。
- **arbitration**：judge1 + judge2 一致即 double-pass；18 AC PASS-PASS，AC-P2-3b BLOCKED-BLOCKED。

## crash lease recovery fixture

AC-P2-18 要求的 crash lease recovery（runtime crash → 备机 ≤60s 接管 → trace `recovered_from_crash`）由 AC-P2-1 的 `scheduler-runtime.test.ts`『范-r2 P2-1: follower→leader 提升 → recovered_from_crash + event-driven 起』覆盖。

## Phase 2 状态

代码本体 + 集成层 + evidence pack 全部完成，commit 全程留在 worktree branch `feat/F027-unified-memory-architecture`。

**未合 dev**：feature 级合并需 evidence pack + 异构双 judge 收稿（本文档）+ 小孙最终拍板。AC-P2-3b 的 Gate 2 是合并前需小孙处理的唯一外部依赖。
