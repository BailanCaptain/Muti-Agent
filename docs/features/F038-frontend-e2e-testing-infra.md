---
id: F038
title: 前端 E2E 自动化测试基建 — Playwright 真点击验证前后端交互 + agent 浏览器测试流程
status: spec
owner: 黄仁勋
created: 2026-07-03
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

- [ ] AC1: `pnpm test:e2e` 存在并跑 `@playwright/test`；`tests/e2e/` 至少 1 个真实用例含真点击/输入（click/fill）并断言 UI 变化
- [ ] AC2: E2E harness 自起隔离 web + api：SQLITE_PATH 指向临时目录（实测验证主库 `./data/multi-agent.sqlite` 与 `.runtime/worktree-preview` 的 mtime 在 E2E 运行前后不变）；端口 env 可覆盖且默认值避开 :3000/:8787/:3100+/:8800+
- [ ] AC3: ≥1 条用例覆盖「前端操作 → 后端持久化 → 前端可见」全链路（对后端状态有独立断言，不是纯渲染测试）
- [ ] AC4: 失败时自动留证物（trace / screenshot），证物目录已在 .gitignore，不进 git 历史
- [ ] AC5: golden rules 固化进配置与文档：baseURL 进 config（用例零硬编码 URL）、语义选择器优先（getByRole/getByText）、禁 `waitForTimeout`（web-first assertions）
- [ ] AC6: `multi-agent-skills/webapp-testing/SKILL.md` + manifest.yaml 条目落地，`pnpm check:skills` 绿；skill 内容覆盖：何时触发、server 生命周期、侦察后行动模式、选择器纪律、证据留存
- [ ] AC7: 流程接线：quality-gate 与 acceptance-guardian 的 SKILL.md 增加「涉及前后端交互的 feature 必须附浏览器实操/E2E 证据」检查项
- [ ] AC8: 假阳性验证（沿 F025 AC-08 惯例）：故意改坏一处交互 → E2E 正确 FAIL → 恢复 → 绿
- [ ] AC9: 现有测试零回归：`pnpm test`（tsx --test + vitest）仍绿；E2E 不并入默认 `pnpm test`（需浏览器 + 长跑，单独命令 + CI 单独 job 策略见 Design Decisions）
- [ ] AC10: `multi-agent-skills/refs/frontend-testing.md` 增补「E2E 怎么写」速查（含本仓 harness 用法、常见坑）

## Dependencies

- F025（前端单测基建）— 已 done，本 feature 是其显式 YAGNI 项的补齐
- F024（worktree 验收基建）— 已 done，端口段与布线契约（`packages/shared/src/preview-env.ts`）复用
- 无未完成的阻塞依赖

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| E2E 框架 | @playwright/test (TS) / Python sync_playwright（anthropics 原版）/ Cypress | **@playwright/test** | 全仓 TS/pnpm 生态无 Python 工具链；chromium 已随 packages/api playwright 装好；anthropics skill 取的是工作流思想不是语言 |
| runner | @playwright/test 独立 runner / vitest + playwright 插件 | **独立 runner** | trace、retry、webServer、HTML report 原生；与 vitest 组件测试职责分离（F025 双框架并存先例） |
| server 编排 | playwright `webServer[]` 数组 / 自研 with_server 脚本（anthropics 式） | **playwright webServer[]** | 原生支持多 server + 端口就绪探测 + 复用已起 server（`reuseExistingServer`）；不重造轮子 |
| DB 隔离 | 临时 SQLite 文件 / 内存 DB / 复用 preview DB | **临时 SQLite（scratchpad/os.tmpdir）** | Iron Law 1；preview DB 是验收现场不可污染；每次 E2E 冷启动干净可重现 |
| 端口 | 固定专用段（默认 3999/8999，env 可覆盖）/ 动态分配 | **固定默认 + env 覆盖** | webServer 需要确定 baseURL；避开 :3000/:8787 主库与 :3100+/:8800+ preview 段；worktree 并行跑时用 env 错开 |
| CI 接入 | 并入 `pnpm test` 门禁 / 单独 job（非阻塞起步）/ 不接 | **单独 workflow job，先非阻塞** | docs-watcher flaky 教训：新 E2E 直接进硬门禁易假红拖垮全队；跑稳一段时间后再升级为必过门禁（升级点记 TD） |
| skill 形态 | 单 SKILL.md / 带 helper 脚本包 | **SKILL.md + 指向真实 harness** | 家规 P4：harness 本身就是单一真相源，skill 只写工作流与纪律，不复制配置细节 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-03 | Kickoff（小孙 /goal 指定需求 + 两个参考仓库） |

## Links

- 参考：[testdino-hq/playwright-skill](https://github.com/testdino-hq/playwright-skill)（golden rules / 选择器与断言纪律）
- 参考：[anthropics/skills webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)（agent 工作流：server 生命周期 / 侦察后行动）
- Related: [F025](F025-frontend-unit-test-infra.md) / [F024](F024-worktree-vision-acceptance-infra.md)

## Evolution

- **Evolved from**: F025（前端单测基建 — 其「不做 E2E」YAGNI 项到期）
- **Blocks**: 无
- **Related**: F024（验收同源基建，E2E 证物同样落 worktree 本地）；F033（交互卡片 — 首批受益者，点击流验收可自动化）
