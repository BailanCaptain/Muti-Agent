# F025 Frontend Unit Test Infra — Implementation Plan

**Feature:** F025 — `docs/features/F025-frontend-unit-test-infra.md`
**Goal:** 给 repo 补前端组件单测能力（vitest + @testing-library/react + happy-dom），与现有 `tsx --test` 后端测试并存且互不干扰。
**Acceptance Criteria:**
- AC-01：`pnpm test:components` 命令存在、跑 vitest、扫 `components/**/*.test.{ts,tsx}`
- AC-02：根目录 `pnpm test` 聚合跑后端（tsx --test）+ 前端（vitest），全绿
- AC-03：存在至少 1 个真实前端组件测试文件，断言 DOM 渲染（非占位符），通过
- AC-04：`pnpm typecheck` / `pnpm lint` 对 `.test.tsx` 也生效，不报错
- AC-05：CI 在 PR 上自动跑 `pnpm test`，前端测试纳入门禁
- AC-06：`multi-agent-skills/refs/` 或 feature doc 补一段最短的「前端组件测试怎么写」速查
- AC-07：不影响现有后端测试（`packages/**/*.test.ts` 仍由 tsx --test 跑，0 回归）
- AC-08：示例测试能捕获一个真实的假阳性（故意改坏组件 → 测试挂 → 确认保护有效）

**Architecture:**
- 新增根目录 `vitest.config.ts`（只扫 `components/**/*.test.{ts,tsx}`，`@vitejs/plugin-react` + `happy-dom`）+ `vitest.setup.ts`（RTL matchers）
- `package.json` scripts 拆成 `test:api`（原 `tsx --test`）+ `test:components`（vitest run）+ `test`（顺序执行前者+后者）
- 采样目标组件：`components/chat/chat-header.tsx`（23 行、无 hook/context 依赖、只有 `PawPrint` 图标 + `children` 条件渲染，最适合作 smoke sample）
- pre-commit hook (`pnpm test`) + CI `ci.yml` Test job 均已跑 `pnpm test`，改 script 聚合后自动覆盖前端

**Tech Stack:**
- vitest ^2 · @vitejs/plugin-react ^4 · @testing-library/react ^16 · @testing-library/jest-dom ^6 · @testing-library/dom ^10 · happy-dom ^15

---

## Design Decisions — **✅ APPROVED（Round 2 放行，2026-04-20）**

| # | 决策 | 选项 | 最终结论 | 备注 |
|---|------|------|---------|------|
| 1 | Runner | vitest / jest / node:test+JSX transform | **vitest** | React 19 + Next.js 生态事实默认 |
| 2 | DOM | jsdom / happy-dom | **happy-dom** | 启动快、React 19 兼容；有 API 缺口再切回 jsdom |
| 3 | 断言库 | @testing-library/react / enzyme | **@testing-library/react** | React 19 官方推荐；enzyme 已死 |
| 4 | **与现有 `tsx --test` 关系** | 统一迁 vitest / 并存 | **并存 + 迁移作为 follow-up** | 迁 scope=`packages/**/*.test.ts` + `scripts/**/*.test.ts`，合计 >60 文件；并存代价仅多一个聚合命令 |
| 5 | 测试文件位置 | `__tests__/` 目录 / 同目录 `.test.tsx` | **同目录 `.test.tsx`** | 与后端 `.test.ts` 惯例一致 |

> **Review status**：plan-level review 已完成两轮（Round 1 范德彪 4 条 finding，Round 2 APPROVE WITH MINOR CHANGES + 2 条 P2）。本 Round 3 修订已收口两条 P2，5 项决策均已放行，feature doc Design Decisions 表同步去掉 `provisional` 标记。

---

## Task 1：前置检查（⚠ 不动代码）

**Files:**
- Read: `docs/features/F025-frontend-unit-test-infra.md`
- Read: 本 plan Design Decisions 表（已 APPROVED）

**动作**：
1. plan-level review 已完成（Round 2 放行 + Round 3 收口 2 条 P2，2026-04-20），无需再走 `requesting-review`
2. 小孙确认进 Task 2 即可动手
3. 确认 worktree 已按 `worktree` skill 开好（独立分支：`feat/F025-frontend-unit-test-infra`）

**产出**：worktree 就绪，可进 Task 2

**不做**：任何 `pnpm add` / 写 config / 写测试

---

## Task 2：安装依赖

**Files:**
- Modify: `package.json`（devDependencies 段）
- Modify: `pnpm-lock.yaml`

**Step 1: 精确命令**

```bash
pnpm add -D \
  vitest \
  @vitejs/plugin-react \
  @testing-library/react \
  @testing-library/dom \
  @testing-library/jest-dom \
  happy-dom
```

**Step 2: 验证安装**

```bash
pnpm list --depth=0 vitest @vitejs/plugin-react happy-dom
```

Expected: 三个包均有版本号输出，vitest >= 2.0.0、@vitejs/plugin-react >= 4.0.0、happy-dom >= 15.0.0。

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(F025): 引入前端单测依赖（vitest + RTL + happy-dom） [黄仁勋/Opus-47 🐾]"
```

---

## Task 3：搭 vitest.config.ts + setup 文件

**Files:**
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`

**Step 1: 写 `vitest.config.ts`**（不开 globals，使用 explicit imports）

```typescript
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["components/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"]
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "@multi-agent/shared": path.resolve(__dirname, "packages/shared/src/index.ts")
    }
  }
})
```

> **Review fix（范德彪 Finding 4 · P2）**：删掉 `globals: true`。测试文件统一 `import { describe, it, expect } from "vitest"`，explicit imports 自带类型，tsconfig 无需加 `types: ["vitest/globals"]`。

**Step 2: 写 `vitest.setup.ts`**

```typescript
import "@testing-library/jest-dom/vitest"
```

**Step 3: 写一个最小 smoke test 验证 pipeline 真的跑起来**

Create: `components/chat/__vitest-smoke.test.ts`（临时文件，Task 5 结束后删）

```typescript
import { describe, it, expect } from "vitest"

describe("vitest pipeline smoke", () => {
  it("runs assertions", () => {
    expect(1 + 1).toBe(2)
  })
})
```

**Step 4: 跑 vitest 验证 pipeline 通**

```bash
pnpm exec vitest run
```

Expected: `Test Files  1 passed (1)` / `Tests  1 passed (1)`，退出码 **0**。

> **Review fix（范德彪 Finding 1 · P1）**：原 plan 写 "0 测试时退出码 0" 是错的——vitest v2+ 在 matched 0 tests 时 **退出码 1**（除非配 `passWithNoTests`）。改为先放一个最小 smoke test 证明 pipeline 真的跑起来、断言真的执行，比"空 pipeline 退出码 0"可信得多。

**Step 5: Commit**

```bash
git add vitest.config.ts vitest.setup.ts components/chat/__vitest-smoke.test.ts
git commit -m "feat(F025): vitest 配置 + happy-dom setup + smoke test [黄仁勋/Opus-47 🐾]"
```

（smoke test 在 Task 5 commit 前删除，单独成一个 `chore: 删除 vitest smoke` commit —— 或并入 Task 5 的 commit，两种都 OK）。

---

## Task 4：写一个**会失败**的示例测试（Red）

**Files:**
- Create: `components/chat/chat-header.test.tsx`

**Step 1: 写故意挂的测试**

```typescript
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatHeader } from "./chat-header"

describe("ChatHeader", () => {
  it("renders the product title", () => {
    render(<ChatHeader />)
    // 故意写错的断言 —— 证明 pipeline 真的执行断言、不是 no-op
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("WrongTitle")
  })
})
```

**Step 2: 跑测试，**必须**看到 FAIL**

```bash
pnpm exec vitest run
```

Expected: 1 test failed, assertion message 包含 `Expected: "WrongTitle"` / `Received: "Multi-Agent"`。

**若测试意外 PASS**（或根本没跑）→ 说明 config/include 有漏洞，先停，回 Task 3 排查。

**不 commit**（Red 不留快照）。

---

## Task 5：改断言让测试过（Green）

**Files:**
- Modify: `components/chat/chat-header.test.tsx`

**Step 1: 修正断言**

把 `"WrongTitle"` 改成 `"Multi-Agent"`，并补一条子标题断言 + children 渲染测试，成为一个真正能保护行为的测试组：

```typescript
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatHeader } from "./chat-header"

describe("ChatHeader", () => {
  it("renders the product title and subtitle", () => {
    render(<ChatHeader />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Multi-Agent")
    expect(screen.getByText("多智能体协同工作空间")).toBeInTheDocument()
  })

  it("renders children slot when provided", () => {
    render(
      <ChatHeader>
        <button type="button">ActionSlot</button>
      </ChatHeader>
    )
    expect(screen.getByRole("button", { name: "ActionSlot" })).toBeInTheDocument()
  })

  it("omits children container when none provided", () => {
    render(<ChatHeader />)
    expect(screen.queryByRole("button", { name: "ActionSlot" })).not.toBeInTheDocument()
  })
})
```

**Step 2: 跑测试，必须 PASS**

```bash
pnpm exec vitest run
```

Expected: `3 passed`。

**Step 3: Commit**

```bash
git add components/chat/chat-header.test.tsx
git commit -m "test(F025): ChatHeader 组件单测（AC-03 示例测试） [黄仁勋/Opus-47 🐾]"
```

**覆盖 AC**：AC-03。

---

## Task 6：AC-08 伪阳性验证（篡改 → 挂 → 恢复）

**目的**：证明测试真的保护代码行为，不是"瞎写但永远过"。

**Step 1: 用 Edit 工具篡改 `components/chat/chat-header.tsx:15`**

通过 Edit 工具（**不用 git**）把 `<h1 className="...">Multi-Agent</h1>` 里 `Multi-Agent` 改成 `Broken`。

**Step 2: 跑测试，必须 FAIL**

```bash
pnpm exec vitest run
```

Expected: `renders the product title and subtitle` 挂，错误信息含 `Expected: "Multi-Agent"` / `Received: "Broken"`。

**Step 3: 用 Edit 工具把 `Broken` 改回 `Multi-Agent`**

再跑一次验证恢复：
```bash
pnpm exec vitest run
```
Expected: `3 passed`。

**Step 4: git status 验证 working tree 干净**

```bash
git status --short components/chat/chat-header.tsx
```
Expected: 输出为空（文件完全恢复到 HEAD 状态）。

> **Review fix（范德彪 Finding 3 · P2）**：原 plan 用 `git checkout -- <file>` 恢复，是 destructive 操作，会连带覆盖同文件中其他未 commit 改动。改为 Edit 工具定点改 + 定点还原，git 完全不参与，最后 `git status --short` 作证清零。

**Step 5: 在 feature doc Timeline 里记一行"AC-08 verified on {date}"**

**不 commit**（只是 AC-08 行为证据、无代码变更）。

**覆盖 AC**：AC-08。

---

## Task 7：`package.json` scripts 聚合

**Files:**
- Modify: `package.json:18`（`"test"` 行）

**Step 1: 修改 scripts**

原行：
```json
"test": "tsx --test \"packages/**/*.test.ts\" \"scripts/**/*.test.ts\"",
```

改为：
```json
"test:api": "tsx --test \"packages/**/*.test.ts\" \"scripts/**/*.test.ts\"",
"test:components": "vitest run",
"test": "pnpm run test:api && pnpm run test:components",
```

**Step 2: 跑根 test 验证聚合**

```bash
pnpm test
```

Expected:
- 先输出 tsx --test 的 "# tests" 汇总（后端所有测试）
- 再输出 vitest 的 `Test Files  1 passed (1)` / `Tests  3 passed (3)`
- 整体退出码 0

**Step 3: 验证单命令分别能跑**

```bash
pnpm test:api      # 只跑后端
pnpm test:components  # 只跑前端
```

Expected: 两个命令均独立成功、退出码 0。

**Step 4: Commit**

```bash
git add package.json
git commit -m "feat(F025): test 脚本聚合前端 vitest + 后端 tsx --test（AC-01/02） [黄仁勋/Opus-47 🐾]"
```

**覆盖 AC**：AC-01, AC-02, AC-07（后端测试数量对比无回归）。

---

## Task 8：验证 typecheck + lint 覆盖 `.test.tsx`

**Files:**
- Read only: `tsconfig.json`（已确认 `components/**/*.tsx` include 已覆盖 `.test.tsx` — `tsconfig.json:38-43`）

**Step 1: 跑 typecheck**

```bash
pnpm typecheck
```

Expected: 退出码 0。因为测试文件用 explicit imports（`import { describe, it, expect } from "vitest"`），vitest 自带类型定义，`.test.tsx` 已被 tsconfig include，**不需要任何 tsconfig 改动**。

**Step 2: 跑 lint**

```bash
pnpm lint
```

Expected: `components/chat/chat-header.test.tsx` 无 biome 错。

**Step 3: 无 commit**（本 Task 只跑验证，不改任何文件）

> **Review fix（范德彪 Finding 4 · P2）**：原 plan 写"globals: true 模式下需要 types: [vitest/globals]"——但 plan 实际用 explicit imports，`globals: true` 已在 Task 3 删掉。本 Task 简化为纯验证，删除条件 tsconfig 改动分支。

**覆盖 AC**：AC-04。

---

## Task 9：文档速查（「前端组件测试怎么写」）

**Files:**
- Create: `multi-agent-skills/refs/frontend-testing.md`

**Step 1: 写速查（≤ 80 行）**

内容骨架：
1. **起步**：`pnpm test:components` / 单文件 `pnpm exec vitest run components/chat/chat-header.test.tsx`
2. **import 路径**：`import { render, screen } from "@testing-library/react"`、`import { describe, it, expect } from "vitest"`
3. **最小模板**（贴 chat-header.test.tsx 精简版作 5 行模板）
4. **常见坑**：
   - happy-dom 不支持 `ResizeObserver` / `IntersectionObserver` → 需 mock（给一个 `globalThis.ResizeObserver = vi.fn()` 示例）
   - zustand store 跨测试状态污染 → 在 `beforeEach` 里 `store.setState(initialState)` 或用 `vi.resetModules()`
   - Server Component 默认不能 render（我们的组件都是 `"use client"`，无问题）
   - 使用 `getByRole` 优先于 `getByTestId`（RTL 哲学）
5. **何时写 / 不写单测**：纯渲染 + props 映射 → 写；涉及 server action / WS / fetch → 转去 F024 L1/L2 人眼验收

**Step 2: 在 feature doc `## Links` 下追加**

```markdown
- Cheatsheet: `multi-agent-skills/refs/frontend-testing.md`
```

**Step 3: Commit**

```bash
git add multi-agent-skills/refs/frontend-testing.md docs/features/F025-frontend-unit-test-infra.md
git commit -m "docs(F025): 前端组件测试速查 + feature doc 链入 [黄仁勋/Opus-47 🐾]"
```

**覆盖 AC**：AC-06。

---

## Task 10：CI 验证 + 最终回归

**Files:**
- Read: `.github/workflows/ci.yml`（已确认 CI 有 **5 个 job**：typecheck / test / lint / build / doc-check，均跑 `pnpm <subcommand>`，无需改）

**Step 1: 本地完整回归**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm check:docs
```

Expected: 全部退出码 0。`pnpm check:docs` 对应 CI `doc-check` job，Task 9 新增了 `multi-agent-skills/refs/frontend-testing.md` + 改了 feature doc，本地必须先验证这个 job 不会挂。

**Step 2: 后端测试数量对比（防 AC-07 回归）**

基线：F025 kickoff commit `12dc561` 的 commit message 和范德彪之前的汇报均为 "821 tests 全绿"。

在 worktree 内执行（**不做** `git stash` + `checkout dev`）：
```bash
pnpm exec tsx --test "packages/**/*.test.ts" "scripts/**/*.test.ts"
```

（直接调原命令，绕过 Task 7 改过的 `pnpm test` script 聚合。）

Expected: `# tests` 输出 ≥ 821（只增不减）。若有减少 → AC-07 回归，停工排查。

> **Review fix（范德彪 Finding 2 · P1）**：原 plan 用 `git stash + checkout dev` 跑基线——这对 worktree 不可行（stash 推全局堆、checkout dev 与主 repo 撞 "already checked out"）。改为直接在 worktree 内跑原命令 + 对比 commit `12dc561` 的 821 基线（commit message 是权威真相源）。

**Step 3: 推 PR 前跑 pre-commit 全链**

任意小改动触发 pre-commit（或直接 `.husky/pre-commit` 手跑），确认 4 步全通：
- typecheck ✓
- check-docs ✓
- lint-staged ✓
- test ✓（含 vitest）

**Step 4: Push + 观察 CI**

```bash
git push -u origin feat/F025-frontend-unit-test-infra
```

PR 创建后检查 CI Gate 的 **5 个 job**（typecheck / test / lint / build / **doc-check**）全绿。

- 若 test job 挂 → 排查 node_modules / pnpm-lock / happy-dom Linux 兼容
- 若 doc-check job 挂 → `pnpm check:docs` 本地复现，大概率是 feature doc/plan doc 路径或链接问题
- 若 build job 挂 → `pnpm build` 本地复现，大概率是 vitest 类型定义被 `next build` 意外捞走

> **Review fix（范德彪 Residual Risk）**：原 plan 写"CI 4 个 job"——实际 5 个（`.github/workflows/ci.yml:66-71` 有 `doc-check`）。Task 9 改了 docs 所以这个 job 是 **本 feature 新引入的风险点**，Step 1 已显式跑 `pnpm check:docs`。

**覆盖 AC**：AC-05, AC-07。

---

## Summary — AC 覆盖矩阵

| AC | Task | 验证证据 |
|----|------|---------|
| AC-01 `pnpm test:components` 存在 | Task 7 | `pnpm test:components` 退出码 0 |
| AC-02 `pnpm test` 聚合全绿 | Task 7 | `pnpm test` 退出码 0，含两段输出 |
| AC-03 至少 1 个真实组件测试 | Task 5 | `chat-header.test.tsx` 3 个测试通过 |
| AC-04 typecheck/lint 覆盖 .test.tsx | Task 8 | `pnpm typecheck` + `pnpm lint` 退出码 0 |
| AC-05 CI 在 PR 自动跑 | Task 10 | CI 绿 |
| AC-06 速查文档 | Task 9 | `multi-agent-skills/refs/frontend-testing.md` 存在 + feature doc 链入 |
| AC-07 后端 0 回归 | Task 10 | tsx --test 测试数 N 不减 |
| AC-08 伪阳性验证 | Task 6 | 篡改组件后测试挂、恢复后测试过 |

---

## Commit 轨迹（预期）

1. `chore(F025): 引入前端单测依赖（vitest + RTL + happy-dom） [黄仁勋/Opus-47 🐾]` — Task 2
2. `feat(F025): vitest 配置 + happy-dom setup + smoke test [黄仁勋/Opus-47 🐾]` — Task 3
3. `test(F025): ChatHeader 组件单测 + 删 smoke test（AC-03 示例测试） [黄仁勋/Opus-47 🐾]` — Task 5
4. `feat(F025): test 脚本聚合前端 vitest + 后端 tsx --test（AC-01/02） [黄仁勋/Opus-47 🐾]` — Task 7
5. `docs(F025): 前端组件测试速查 + feature doc 链入 [黄仁勋/Opus-47 🐾]` — Task 9

共 5 个 commit（原 6 条，Task 8 条件 commit 删除——因删了 `globals: true` 后 tsconfig 完全无需改动）。每个 commit 独立可 revert，diff 粒度对 review 友好。

---

## Follow-ups（**不**在本 F025 scope）

- F025+1：把 `packages/**/*.test.ts` 从 `tsx --test` 迁到 vitest（视决策 4 review 结果）
- F025+2：为现有 26 个组件补单测（由对应 frontend feature 增量做）
- F025+3：引入 E2E（playwright） — 目前 F024 已覆盖 L1/L2，无近期需求

---

## Revision History

### 2026-04-20 · Round 1 review（范德彪）→ Round 2 revised plan

范德彪 plan-level review 提出 4 条 finding + 1 residual risk，全部 VERIFY 后接收，plan 已逐项修正：

| Finding | Severity | 原问题 | Plan 修法位置 |
|---------|----------|--------|--------------|
| 1 | P1 | Task 3 `vitest run` 0 测试时预期退出码 0——错，v2+ 退出码为 1 | Task 3 改为先建最小 smoke test（临时文件，Task 5 清理） |
| 2 | P1 | Task 10 AC-07 基线用 `git stash + checkout dev`，worktree 里不可行 | Task 10 Step 2 改为 worktree 内直接跑 `tsx --test` 原命令，对比 commit 12dc561 的 821 基线 |
| 3 | P2 | Task 6 `git checkout --` 是 destructive 操作 | Task 6 改为 Edit 工具定点改 + 定点还原，git 不参与 |
| 4 | P2 | `globals: true` 与 explicit imports 冲突；`.test.tsx` 已被 tsconfig include | vitest.config.ts 删 `globals: true`；Task 8 删掉条件 tsconfig 改动段；commit 轨迹删 Task 8 条件 commit（6→5）|
| R | — | Task 10 说"CI 4 个 job"，实际 5 个（含 doc-check） | Task 10 改为 5 个 job；Step 1 显式跑 `pnpm check:docs`；Step 4 补 doc-check 失败排查 |

**非 blocking（已撤回 / 已接收赞同）**：
- `vite` peer dep 不 blocking（vitest transitively 提供，无需显式装）
- `ChatHeader` 采样组件选择合理（23 行 + 纯 props + children，无 hook/context）

### 2026-04-20 · Round 2 review（范德彪）→ Round 3 revised plan

范德彪 Round 2 复核结论 **APPROVE WITH MINOR CHANGES**，原 4 条 finding + 1 residual risk 修法全部确认。额外 2 条 P2 流程性残留已在本轮收口：

| Finding | Severity | 原问题 | Plan 修法位置 |
|---------|----------|--------|--------------|
| R2-1 | P2 | Design Decisions 表仍标 `PROVISIONAL（待范德彪 review）` + Task 1 仍写 `requesting-review` SOP | 表头改为 `✅ APPROVED`；Task 1 改为"前置检查"（plan-level review 已完成，删除 requesting-review 引用） |
| R2-2 | P2 | 5 个 commit 模板缺 `[昵称/模型 🐾]` 签名（家规硬规则） | Task 2/3/5/7/9 commit 模板 + Commit 轨迹章节全部补 `[黄仁勋/Opus-47 🐾]` |

## Next

本 plan（Round 3 revised）→ 回发给范德彪 reconfirm（预期 trivial 放行）→ 同步 feature doc Design Decisions 去掉 provisional → **`worktree`** 开隔离环境（`feat/F025-frontend-unit-test-infra`）→ **`tdd`** 逐 Task 执行。
