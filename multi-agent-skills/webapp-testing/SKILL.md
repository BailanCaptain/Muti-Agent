---
name: webapp-testing
description: >
  用 Playwright 真浏览器自动化验证前端 / 前后端交互（真点击、真 API、真落库）。
  Use when: feature 涉及前后端交互需要自动化验证、quality-gate / 验收要浏览器实操证据、
  要写 / 跑 / 调 E2E 用例、"自动点击测试"。
  Not for: 纯组件渲染测试（vitest 组件单测）、纯后端逻辑（tsx --test）、
  视觉美学判断（人眼 / 桂芬）。
  Output: E2E 用例 + 运行输出 / trace / 截图证据。
---

# Webapp Testing — 真浏览器自动化验证

F038 基建。测试哲学取 testdino playwright-skill（golden rules），agent 工作流取
anthropics webapp-testing（server 生命周期 + 侦察后行动）。

## 核心知识

**harness 单一真相源 = `playwright.config.ts`**：`pnpm test:e2e` 自动起隔离 API(:8999) +
Web(:3999)，数据全落 os.tmpdir 一次性目录（SQLITE/uploads/wiki-root），scheduler /
docs-watcher 全关，跑完自动杀。**你不需要手动起任何 server。**

**两种用法**：

| 模式 | 场景 | 做法 |
|------|------|------|
| 回归 | 自检 / 验收时确认没改坏 | 直接 `pnpm test:e2e` |
| 专项 | 为当前 feature 验证新交互 | 在 `tests/e2e/` 写 spec；有长期回归价值的留下，一次性的验完删 |

## 铁律（对齐 Iron Laws + F024 端口纪律）

1. **临时 DB**：E2E 永不指向 `./data/multi-agent.sqlite` / `.runtime/worktree-preview/`。
   harness 的 `buildE2eEnv` 已 fail-closed 强制（命中真实路径特征直接 throw）。
2. **端口纪律**：默认 :3999/:8999；并行跑用 `E2E_WEB_PORT`/`E2E_API_PORT` 错开。
   禁碰主库 :3000/:8787 与 preview 段 :3100+/:8800+。`reuseExistingServer:false` 是
   有意设计——端口 ready ≠ 是本轮的 server，被占就换端口，别改成复用。
3. **禁真 LLM 派发**：E2E 里不发带 @agent 的消息（composer 强制 @ → 会真 spawn CLI
   provider）。消息链路验证到「输入框交互」为止，派发链路归后端集成测试。

## Golden Rules（写用例必守）

1. 语义选择器优先：`getByRole` > `getByLabel` > `getByText` > `getByTestId`；
   heading 类文案注意 `exact: true`（"会话" 会 substring 命中 "新会话 …" 卡片标题）
2. 禁 `waitForTimeout` — 用 web-first assertion（`expect(locator).toBeVisible()` 自带重试）
3. URL 零硬编码 — baseURL 在 config，用例里 `page.goto("/")`
4. 断言不拿 DOM count 当后端真相 — 列表有 limit=200 + 滚动截断；
   正确姿势：`page.waitForResponse` 拿 POST 返回的实体 id → 用
   `data-session-group-id` 等 testid 锚点断言 UI → `request.get()` 独立断言后端
5. 一个行为一个 test；test 间无共享状态依赖
6. 需要新定位锚点时给产品代码加 `data-testid`（如 `session-card`），不绑 tooltip / 时间戳文案

## 侦察后行动（写新用例的流程）

1. **侦察**：先跑一次带 `--headed` 或看失败截图/`error-context.md` 了解真实渲染态，
   从渲染结果提取选择器 — 别对着 tsx 源码猜
2. **行动**：用侦察到的选择器写交互 + 断言
3. **验红**：故意断开被测交互（如 onClick 置空）确认用例会 FAIL，再恢复 — 假阳性检查

## 证据留存

- 失败自动留截图 + retry trace：`test-results/`（已 .gitignore）
- 验收证据按 F024 归 `{worktree}/.agents/acceptance/`，不进 git
- 报告引用格式：命令 + `N passed` 输出 + 失败时 trace 路径

## Common Mistakes

| 错误 | 修复 |
|------|------|
| 手动起 dev server 再跑 E2E 打到主库端口 | 直接 `pnpm test:e2e`，harness 自管生命周期 |
| 对着组件源码猜选择器 | 侦察后行动：先看渲染态 |
| `waitForTimeout(3000)` 等加载 | web-first assertion 自动重试 |
| 断言绝对数量（`toHaveCount(1)`） | POST 响应拿 id 精确锚点 + 后端独立断言 |
| E2E 里 @范德彪 发消息测派发 | 禁——会真调 LLM；派发链路归后端集成测试 |
| 用例绿了就宣称覆盖 | 必须做一次验红（假阳性检查） |
| 端口被占改 `reuseExistingServer:true` | 用 E2E_*_PORT 换端口；复用会写进别人的库 |

## 和其他 skill 的区别

- `tdd`：单元级红绿重构；本 skill 是浏览器级端到端验证
- `quality-gate`：自检门禁（引用本 skill 产出的证据）；本 skill 是产证据的工具
- `acceptance-guardian`：零上下文验收（可用本 skill 复跑 AC）；本 skill 不做判定

## 下一步

验证通过 → `quality-gate`（把 E2E 输出写进合规报告）
