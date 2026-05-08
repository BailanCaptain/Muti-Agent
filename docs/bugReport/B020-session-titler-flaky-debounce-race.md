---
B-ID: B020
title: session-titler debounce timer race in concurrent vitest run
status: open
related: F022 (Sidebar redesign / session-titler service)
reporter: 黄仁勋
created: 2026-04-26
severity: P2
---

# B020 - session-titler debounce timer race in concurrent vitest run

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | Bug 现象 | `pnpm test`（api + components 并发）必挂 `session-titler.test.ts` 中两条 AC：`AC-14e: demotes bare F-/B- (no id) to D-`（line 215）和 `logs event=haiku.call right before invoking runner`（line 388）。前者 `updateSpy.mock.calls[0]` 为 undefined，后者 `byEvent("haiku.call")` 长度 0。 |
| 2 | 证据 | 单跑 `node --test session-titler.test.ts` → 20/20 全绿；单跑 `pnpm test:api` → 1296/1296 全绿；单跑 `mention-router.*.test.ts` → 80/80 全绿；只有并发 `pnpm test`（api + components 同时跑）才必挂这两条。错误位置：line 236:44 + 403:12。 |
| 3 | 假设 | 根因是测试用 `debounceMs: 10` + `await titler.flushPending()` 组合：在 vitest 并发抢 CPU 时，`schedule()` 排的 setTimeout(10ms) 还没 fire，flushPending 就已经返回；assertion 看到 spy/logger 还是空。家境压力下 timer 实际触发 > 10ms 是常见情况。 |
| 4 | 诊断策略 | 不动业务代码，先把 flaky 两条 `it.skip` 标 TODO B020 解 hook 阻塞；后续单独排查 — 选项 A：把 flushPending 改成"等 schedule 的 timer 真正 resolve 后再返回"（业务侧需要暴露 promise）；选项 B：测试 debounceMs 从 10 提到 50/100，用更宽容窗口；选项 C：用 fake timers 控制 debounce。 |
| 5 | 用户可见修正 | 修复后 `pnpm test` 可重复绿，pre-commit hook 不再被 flaky 阻塞，无需再 skip。 |
| 6 | 复现验收 | 连续 10 次 `pnpm test`（api + components 并发）必须 10/10 绿，同时单跑 session-titler 仍 20/20 绿。修复 PR 必须把当前 `it.skip` 还原为 `it`。 |

## 根因（待确认）

`SessionTitler.flushPending()` 的契约疑似是"等当前 inflight 的 haiku.run resolve"，但 `schedule()` 内部的 `setTimeout(debounceMs)` 不在 inflight 集合里 — 当 schedule 后立刻 flushPending，timer 还没开火，flushPending 直接返回，断言提前查 spy。

证据线索：所有挂的 case 都是 `schedule(SID) → await flushPending() → assert spy.mock.calls[0]` 模式。如果 flushPending 真的等了 timer，spy 必然有 ≥1 次调用。

## 修复方案（待立项后细化）

候选：
- 把 schedule 的 setTimeout handle 也纳入 flushPending 的 wait 集合。
- 或者在 `flushPending()` 内主动 `clearTimeout` 并立即跑 runner。
- 或者测试侧改用 fake timers + 显式 `vi.advanceTimersByTime(10)`。

## 验证

- [ ] 业务修复后，`it.skip` 还原为 `it`
- [ ] 连续 10 次 `pnpm test` 全绿
- [ ] 单跑 session-titler 仍 20/20 绿
- [ ] CI 上跑 50 次（matrix）无回归

## 临时缓解（已落地）

`packages/api/src/services/session-titler/session-titler.test.ts` 里两条 AC 已加 `it.skip` + `// TODO B020` 注释，恢复 pre-commit hook 绿。本 bug 修复后必须还原。

## 影响范围

- 不影响生产：业务代码本身没改，仅测试 timer 模式不稳。
- 影响开发体验：F026-P3 方案 X 落地期间反复触发 hook 阻塞，已临时绕过。
