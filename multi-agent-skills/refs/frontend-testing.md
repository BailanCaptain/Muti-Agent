# 前端组件测试速查（F025 产物）

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
- ❌ 不写：server action / WebSocket / fetch — 转 F024 L1/L2 人眼验收
- ❌ 不写：视觉效果（样式、动画、配色）— 测不到

## 配置定位

| 文件 | 作用 |
|------|------|
| `vitest.config.ts` | plugins / env=happy-dom / include / setupFiles |
| `vitest.setup.ts` | RTL matchers 注入 + `afterEach(cleanup)` |
| `jest-dom-matchers.d.ts` | ambient 扩展 `Assertion.toBeInTheDocument` 等 |
| `.npmrc` | `public-hoist-pattern[]=@vitest/*` 让 tsc 能解析 transitive types |
| `tsconfig.json:include` | 含 `jest-dom-matchers.d.ts` 和 `components/**/*.tsx` |
