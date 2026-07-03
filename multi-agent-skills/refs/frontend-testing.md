# 前端测试速查（F025 组件单测 + F038 E2E）

## 起步

```bash
pnpm test:components                                        # 跑全部组件测试
pnpm exec vitest run components/chat/chat-header.test.tsx   # 单文件
pnpm test                                                   # 聚合跑：后端 tsx --test + 前端 vitest
```

## Import 约定（**不**用 `globals: true`）

```ts
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
```

## 最小模板

```tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Foo } from "./foo"

describe("Foo", () => {
  it("renders", () => {
    render(<Foo />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("expected")
  })
})
```

## 常见坑

### 1. DOM 残留跨测试污染
没有 `globals: true` 时 RTL 不会自动注册 `afterEach(cleanup)`。我们在
`vitest.setup.ts` 里显式挂了，新 repo fork / 冷启动环境下如果 setup 文件被跳过，
三条以上的 `render(<X/>)` 会跨测试留下 DOM，`queryByRole` 断言异常。

### 2. happy-dom 不实现 ResizeObserver / IntersectionObserver
组件里用到这两个 observer 时，单测会在 render 阶段抛 ReferenceError。
```ts
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: () => {},
  unobserve: () => {},
  disconnect: () => {},
}))
```

### 3. zustand / jotai 跨测试状态污染
store 是模块级单例。选其一：
- `beforeEach(() => useStore.setState(initialState))`
- `vi.resetModules()` + 重新 `await import("./store")`

### 4. Server Component 不能直接 render
RSC 依赖服务端 async 环境，happy-dom 跑不起来。我们所有对话侧组件都是
`"use client"`，不遇到。要测的 RSC 走 F024 L1/L2 人眼验收。

### 5. 查询优先级（RTL 哲学）
`getByRole` > `getByLabelText` > `getByText` > `getByTestId`。
`getByTestId` 是兜底，不作首选。

## 何时写 / 不写单测

- ✅ 写：纯渲染 + props 映射 + 条件显隐 + slot 插入
- ❌ 不写：server action / WebSocket / fetch — **转 F038 E2E**（`tests/e2e/`）；E2E 也覆盖不了的转 F024 L1/L2 人眼验收
- ❌ 不写：视觉效果（样式、动画、配色）— 测不到

## E2E 速查（F038 产物 · 详细纪律见 `webapp-testing` skill）

```bash
pnpm test:e2e                       # 自动起隔离 API(:8999)+Web(:3999)+temp SQLite，真浏览器跑 tests/e2e/
pnpm exec playwright test --list    # 只枚举用例
pnpm exec playwright test --headed  # 有头模式侦察渲染态
E2E_WEB_PORT=3998 E2E_API_PORT=8998 pnpm test:e2e   # 端口被占/并行时错开
```

最小用例模板（全链路断言三件套：POST 响应拿 id → testid 锚点断言 UI → request 独立断言后端）：

```ts
import { expect, test } from "@playwright/test"

test("点击新建 → 前端可见 + 后端可查", async ({ page, request }) => {
  await page.goto("/")   // baseURL 在 playwright.config.ts，零硬编码
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/session-groups") && r.request().method() === "POST"),
    page.getByRole("button", { name: "新建" }).click(),
  ])
  const { groupId } = await res.json()
  await expect(page.locator(`[data-session-group-id="${groupId}"]`)).toBeVisible()
  const bootstrap = await request.get("http://localhost:8999/api/bootstrap")
  expect((await bootstrap.json()).sessionGroups.some((g: { id: string }) => g.id === groupId)).toBeTruthy()
})
```

常见坑：

1. `getByRole("heading", { name: "会话" })` substring 命中「新会话 …」卡片标题 → 加 `exact: true`
2. 端口被占别改 `reuseExistingServer:true`（会连到别人的 server/库）→ 用 `E2E_*_PORT` 换端口
3. 禁发带 @agent 的消息（真 spawn CLI provider = 真 LLM 调用）
4. temp 目录偶发残留（Windows WAL 锁）是预期行为，OS 临时区自会回收
5. 断言别用绝对 count（列表 limit=200 + 滚动截断）→ 实体 id 精确锚点

## 配置定位

| 文件 | 作用 |
|------|------|
| `vitest.config.ts` | plugins / env=happy-dom / include / setupFiles |
| `vitest.setup.ts` | RTL matchers 注入 + `afterEach(cleanup)` |
| `jest-dom-matchers.d.ts` | ambient 扩展 `Assertion.toBeInTheDocument` 等 |
| `.npmrc` | `public-hoist-pattern[]=@vitest/*` 让 tsc 能解析 transitive types |
| `tsconfig.json:include` | 含 `jest-dom-matchers.d.ts` 和 `components/**/*.tsx` |
| `playwright.config.ts` | F038 E2E harness 单一真相源（隔离 env / webServer / trace） |
| `packages/shared/src/e2e-env.ts` | E2E 隔离环境映射 + Iron Law 1 fail-closed 护栏 |
| `tests/e2e/*.spec.ts` | E2E 用例（@playwright/test 独立 runner，不进 vitest/tsx --test） |
