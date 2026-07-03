---
id: F038
title: 前端 E2E 自动化测试基建 — Playwright 真点击验证前后端交互 + agent 浏览器测试流程
status: done
owner: 黄仁勋
created: 2026-07-03
completed: 2026-07-03
---

# F038 — 前端 E2E 自动化测试基建

**Created**: 2026-07-03

## Why

> 小孙（2026-07-03 原话）："我们目前好像没有前端的自动化测试，feature 做的时候涉及前后端交互的时候，只有简单的测试用例，无法自动点击来验证测试效果，这样测试大大折扣，我们需要一套这样的测试基建和流程，必须参考的：https://github.com/testdino-hq/playwright-skill、https://github.com/anthropics/skills/tree/main/skills/webapp-testing"

现状核实（2026-07-03 实测）：

- **前端测试只有组件单测**（F025 vitest + @testing-library + happy-dom）：假 DOM、fetch/WS 全 mock，覆盖不到「真浏览器点击 → 真 API → 真 DB → UI 更新」链路
- **后端测试**（`tsx --test`）只测 API 内部逻辑，不经过前端
- **E2E 空白是 F025 当年的显式 YAGNI**（F025 doc："不引入 E2E — 已有 worktree:preview 人眼 + F024 L1/L2 覆盖"）——两年 30+ feature 后，人眼验收成为瓶颈：agent 自检只能 take_screenshot 静态截图，交互路径全靠小孙手点
- `packages/api` 已有 `playwright ^1.59.1`（screenshot-service 用 chromium headless），浏览器二进制已在环境中，增量成本低

家规 P5 本来就要求「UX / 前端验证必须打开浏览器实际操作」——本 feature 把这条从"人肉执行"升级为"可自动化执行 + 可留证据"。

## What

四层交付，参考两个指定仓库各取所长：

1. **Playwright E2E 测试层**（testdino golden rules 落地）：`@playwright/test` + `playwright.config.ts` + `tests/e2e/` + `pnpm test:e2e`
2. **隔离 harness**：E2E 自起 web + api，临时 SQLite（Iron Law 1：测试用临时实例，绝不碰主库/preview 库）、专用端口（env 可覆盖，不占 :3000/:8787/:3100+ preview 段）、复用 `buildPreviewEnv` 同款布线契约
3. **种子用例**：≥1 条真点击全链路用例（前端操作 → 后端持久化 → 前端可见）
4. **webapp-testing skill + 流程接入**（anthropics webapp-testing 工作流落地）：agent 在 feature 开发/验收时的浏览器验证 SOP（侦察后行动 / server 生命周期 / 选择器纪律），接进 quality-gate 与 acceptance-guardian 检查项

## Acceptance Criteria

- [x] AC1: `pnpm test:e2e` 存在并跑 `@playwright/test`；`tests/e2e/` 至少 1 个真实用例含真点击/输入（click/fill）并断言 UI 变化 — 3 用例：click（新建）+ fill（搜索）+ 冷启动，3/3 绿 43s
- [x] AC2: E2E harness 自起隔离 web + api：SQLITE_PATH 指向临时目录（实测：主库 mtime `Jul 3 05:25` E2E 前后不变；worktree 内 `.runtime/worktree-preview` 目录零创建）；端口 `E2E_WEB_PORT`/`E2E_API_PORT` 可覆盖，默认 3999/8999 避开 :3000/:8787/:3100+/:8800+
- [x] AC3: 「新建」用例覆盖全链路：POST 响应拿 groupId → `data-session-group-id` 锚点断言 UI → `request.get(/api/bootstrap)` 独立断言后端持久化
- [x] AC4: trace on-first-retry + screenshot only-on-failure → `test-results/`；已入 .gitignore（连同 playwright-report/）
- [x] AC5: baseURL 进 config（用例 `page.goto("/")` 零硬编码）；getByRole/getByTestId 语义/锚点选择器；用例零 `waitForTimeout`（grep 验证仅注释提及）
- [x] AC6: SKILL.md + manifest（/e2e）+ BOOTSTRAP 行落地；`pnpm check:skills` 0 error（1 warning 为 refs 既有基线，主仓 2 warning）；registry.test 16→17 同步
- [x] AC7: quality-gate「UX/前端专项」升级 E2E 首选路径；acceptance-guardian Feature Mode 增「前后端交互 AC 无浏览器级证据判 ❌」
- [x] AC8: 断开新建 onClick → 点击流用例正确 FAIL（waitForResponse 超时）→ 恢复 → 3/3 绿
- [x] AC9: `pnpm test` 全绿（后端 3542：3540 pass/0 fail/1 skip/1 todo + 前端 vitest 807/807）；E2E 独立命令不并入默认 test；CI 单独 `e2e` job（continue-on-error 起步，TD-F038-1 量化升级条件）
- [x] AC10: refs/frontend-testing.md 增 E2E 速查（命令 / 三件套断言模板 / 五坑 / 配置定位表）

## Dependencies

- F025（前端单测基建）— 已 done，本 feature 是其显式 YAGNI 项的补齐
- F024（worktree 验收基建）— 已 done，端口段与布线契约（`packages/shared/src/preview-env.ts`）复用
- 无未完成的阻塞依赖

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| E2E 框架 | @playwright/test (TS) / Python sync_playwright（anthropics 原版）/ Cypress | **@playwright/test@1.59.1（锁版本）** | 全仓 TS/pnpm 生态无 Python 工具链；锁 1.59.1 复用 packages/api playwright 已装的 chromium-1217（德彪 r1 P3-2）；anthropics skill 取的是工作流思想不是语言 |
| runner | @playwright/test 独立 runner / vitest + playwright 插件 | **独立 runner** | trace、retry、webServer、HTML report 原生；与 vitest 组件测试职责分离（F025 双框架并存先例） |
| server 编排 | playwright `webServer[]` 数组 / 自研 with_server 脚本（anthropics 式） | **playwright webServer[]** | 原生支持多 server + 端口就绪探测；不重造轮子 |
| API 启动命令 | `pnpm dev:api` / 专用最小命令 | **`tsc shared && tsx api/index.ts`（一次性，无 watch）+ 隔离 kill-switch** | 德彪 r1 P1-1/P2-1：dev:api 带 mount-skills 副作用 + tsx watch（Windows tree-kill 残留面）；scheduler/docs-watcher/wiki reindex 用 `MULTI_AGENT_SKIP_SCHEDULER=1` + `MULTI_AGENT_DOCS_WATCHER=0` + `WIKI_ROOT=<temp>` 全关（buildE2eEnv 注入，实证锚点见 e2e-env.ts 头注） |
| DB 隔离 | 临时 SQLite 文件 / 内存 DB / 复用 preview DB | **临时 SQLite（os.tmpdir mkdtemp）+ fail-closed 护栏** | Iron Law 1；`buildE2eEnv` 对 runRoot 命中真实数据路径特征直接 throw；teardown best-effort（Windows WAL 锁清理失败不判红，德彪 r1 P2-1） |
| 端口 | 固定专用段（默认 3999/8999，env 可覆盖）/ 动态分配 | **固定默认 + env 覆盖 + `reuseExistingServer:false`** | 德彪 r1 P1-2：端口 ready ≠ 本轮 temp DB 的 server，复用会把断言写进别人的库；fail-closed——被占直接报错，用 env 换端口 |
| 后端持久化断言姿势 | DOM count 相对断言 / 实体 id 精确断言 | **POST 响应拿 id → testid 锚点断言 UI → request.get 独立断言后端** | 德彪 r1 P2-2：listSessionGroups limit=200 + 滚动列表，DOM count 会 flake 且掩盖误连 |
| 选择器契约 | tooltip/文案模式匹配 / 产品代码加稳定锚点 | **`data-testid="session-card"` + `data-session-group-id`** | 德彪 r1 P2-3：title 拼创建时间/消息数是 UI 层可变文本，不做定位契约 |
| CI 接入 | 并入 `pnpm test` 门禁 / 单独 job（非阻塞起步）/ 不接 | **单独 job `e2e`（continue-on-error）+ 量化升级条件** | docs-watcher flaky 教训 + 德彪 r1 P2-5：**TD-F038-1**（owner 黄仁勋）——主干连续 20 次全绿或 2026-08-01 前无 flake → 删 continue-on-error 升硬门禁；到期未达标回本 doc 记录原因再续期 |
| skill 形态 | 单 SKILL.md / 带 helper 脚本包 | **SKILL.md + 指向真实 harness** | 家规 P4：harness 本身就是单一真相源，skill 只写工作流与纪律，不复制配置细节 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-03 | Kickoff（小孙 /goal 指定需求 + 两个参考仓库） |
| 2026-07-03 | 德彪设计审 r1：2P1+5P2+2P3 → GO-WITH-CHANGES，**全接**（专用 API 命令+kill-switch / reuse:false / id 精确断言 / testid 锚点 / fill 用例 / CI 量化升级条件 / gitignore / 锁版本）|
| 2026-07-03 | 实施完成：harness + 3 种子用例 3/3 绿（43s）+ AC8 验红（断 onClick → 点击流用例 FAIL → 恢复绿）+ AC2 隔离证据（主库 mtime 不变 / preview 目录零创建）|
| 2026-07-03 | 德彪代码审 r2：r1 九处落地逐行核实 + 0P1/1P2/1P3 → GO-WITH-CHANGES，全接（P2 plan「跳过 guardian」与流程真相源冲突→改「零上下文复核本轮证据」；P3 护栏漏 data 子路径→Red→Green 放宽正则 `[\\/]data([\\/]|$)` + 文案降级为黑名单兜底）|
| 2026-07-03 | 零上下文 acceptance-guardian **PASS 10/10**（全命令亲自复跑：E2E 3/3 绿 45.8s / 主库 mtime 实证不变 / temp 落点亲证 / 护栏 5/5 / 全量测试 EXIT=0 / 证物对照表 4 条全 ✅）；报告落 worktree `.agents/acceptance/F038/`（manifest 三元组齐，随 worktree 清理消失，正文结论已入本 doc）|
| 2026-07-03 | 德彪 r3：「GO — 两处修复达意，未发现新的阻塞点」|
| 2026-07-03 | rebase origin/dev 全量复验（3567 后端 + 812 前端 + E2E 3/3；ingest-modal 负载 flaky 一次孤立复跑 27/27 过）→ 单 squash 合 dev（实现+收口合一 commit） [黄仁勋/Fable-5 🐾] |

## Links

- Plan: [F038 实施计划](../plans/F038-frontend-e2e-testing-infra-plan.md)
- 参考：[testdino-hq/playwright-skill](https://github.com/testdino-hq/playwright-skill)（golden rules / 选择器与断言纪律）
- 参考：[anthropics/skills webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)（agent 工作流：server 生命周期 / 侦察后行动）
- Related: [F025](F025-frontend-unit-test-infra.md) / [F024](F024-worktree-vision-acceptance-infra.md)

## Evolution

- **Evolved from**: F025（前端单测基建 — 其「不做 E2E」YAGNI 项到期）
- **Blocks**: 无
- **Related**: F024（验收同源基建，E2E 证物同样落 worktree 本地）；F033（交互卡片 — 首批受益者，点击流验收可自动化）
