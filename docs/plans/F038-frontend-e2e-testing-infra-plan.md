# F038 实施计划（前端 E2E 测试基建）

> Spec: [F038](../features/F038-frontend-e2e-testing-infra.md) · Worktree: `.worktrees/F038`
> 设计前提：德彪设计审 r1（GO-WITH-CHANGES，2P1+5P2+2P3 全接，见 feature doc Design Decisions）

## Phase 1 — E2E 基建核心（AC1-5, 8, 9）

| # | Task | TDD | 检查点 |
|---|------|-----|--------|
| 1.1 | root devDep `@playwright/test@1.59.1`（锁版本复用 chromium-1217）+ `test:e2e` 脚本 + .gitignore（test-results/ playwright-report/） | — | `pnpm exec playwright --version` = 1.59.1 |
| 1.2 | `packages/shared/src/e2e-env.ts`：隔离环境映射（4×NEXT_PUBLIC 布线 + temp 数据面 + scheduler/docs-watcher kill-switch + Iron Law fail-closed 护栏） | 先写 e2e-env.test.ts 验 RED（module 不存在）→ 实现 → GREEN 4/4 | `tsx --test` 绿 |
| 1.3 | `playwright.config.ts`：webServer[]（专用 API 命令无 watch 无 mount-skills + next dev）/ reuseExistingServer:false / baseURL / trace on-first-retry / retries CI=2 / workers=1 | — | `playwright test --list` 枚举 3 用例 |
| 1.4 | 种子用例 `tests/e2e/session-groups.spec.ts`：①冷启动（bootstrap 空库自动建组 + WS 连接）②点击「新建」全链路（POST 拿 groupId → testid 锚点断言 UI → request.get 独立断言后端）③搜索框 fill 空态 | E2E 本体即测试 | `pnpm test:e2e` 3/3 绿 |
| 1.5 | 产品测试锚点：session-card `data-testid` + `data-session-group-id`（德彪 r1 P2-3） | — | 用例经锚点定位通过 |
| 1.6 | AC8 验红：断开新建 onClick → 用例 FAIL → 恢复 → 绿；AC2 隔离证据：主库 mtime 前后对比 | 假阳性检查 | 输出留档 quality-gate 报告 |

## Phase 2 — skill + 流程接线（AC6, 7, 10）

| # | Task | 检查点 |
|---|------|--------|
| 2.1 | `multi-agent-skills/webapp-testing/SKILL.md`（走 writing-skills：CSO description / 铁律 / golden rules / 侦察后行动 / 证据留存）+ manifest 条目（/e2e）+ BOOTSTRAP 行 + registry.test 计数 16→17 | `pnpm mount-skills` + `pnpm check:skills` 0 error |
| 2.2 | quality-gate SKILL.md「UX/前端专项」升级（E2E 首选 + 人工兜底）；acceptance-guardian Feature Mode 增「前后端交互 AC 必须浏览器级证据，单测不算」 | 文案落地 |
| 2.3 | refs/frontend-testing.md 增 E2E 速查（命令 / 三件套断言模板 / 五坑） | 文档落地 |
| 2.4 | CI `e2e` job（continue-on-error 非阻塞起步 + failure 上传 trace 证物 + TD-F038-1 量化升级条件注释） | YAML 落地（真跑验证在 merge 后首次 push） |

## Phase 3 — 验证 + review + merge（AC 全量收口）

1. quality-gate：typecheck / lint / test（api+components）/ test:e2e / build 全量真跑
2. quality-gate 后进入 acceptance-guardian（流程真相源「不可跳过」，德彪 r2 P2 纠偏）：
   测试基建类 feature 由零上下文守护 agent **复核本轮证据**（AC 即命令逐条复跑 / 验红记录 / 隔离证据），不重复实现者自检
3. 德彪 code review r2（设计审 r1 已过）→ 收敛 → merge-gate（fetch + rebase origin/dev → squash → push HEAD:dev）

## 风险与对策

- **Windows 残留进程 / WAL 锁**：API 一次性启动（无 watch）缩小 kill 面；temp 清理 best-effort 不判红
- **端口被占**：reuse:false fail-closed 报错 → `E2E_WEB_PORT`/`E2E_API_PORT` 错开
- **CI flake 拖门禁**：非阻塞起步，TD-F038-1 量化条件到期升级
