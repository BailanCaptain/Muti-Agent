---
name: writing-plans
description: >
  将 spec/需求拆分为可执行的分步实施计划。
  Use when: 有 spec 或需求，准备动手前需要拆分步骤。
  Not for: trivial 改动（≤5 行）、已有详细计划。
  Output: 分步实施计划（含 TDD 步骤和检查点）。
---

# Writing Plans

将 spec/需求拆分为分步实施计划。写清楚每步改哪些文件、代码、测试、怎么验证。DRY. YAGNI. TDD. Frequent commits.

**保存计划到**：`docs/plans/{feature-name}-plan.md`

## Straight-Line Check (A→B, 不绕路)

**拆步骤前先做这个**：

1. **Pin finish line**：一句话定义 B + 验收标准 + "我们不做什么"
2. **Define terminal schema**：接口 / 类型 / 数据结构的最终形态——步骤围绕终态构建，不是临时脚手架
3. **每步过三问**：
   - 这步的产物在终态系统中原样保留（只扩展不重写）？→ Yes = 在正轨；No = 绕路
   - 这步完成后能 demo/test 什么？（没有可验证证据 = 绕路）
   - 去掉这步，到达 B 会多什么具体代价？（说不出来 = 绕路）
4. **纯探索 = 显式 Spike**（限时 + 产出是决策/结论，不是交付物）

**步骤是内部实现节奏，不是交付批次。** 交付物是完整的 feat，不是某个步骤的产出。

## Bite-Sized Task Granularity

**每步是一个动作（2-5 分钟）**：
- "写失败测试" — 一步
- "跑测试确认失败" — 一步
- "写最少实现代码" — 一步
- "跑测试确认通过" — 一步
- "Commit" — 一步

## Plan Document Header

**每个计划必须以此 Header 开头**：

```markdown
# {Feature Name} Implementation Plan

**Feature:** F{NNN} — `docs/features/F{NNN}-xxx.md`
**Goal:** {一句话，必须和 feature doc 的 goal 一致}
**Acceptance Criteria:** {从 feature doc 逐条抄过来，plan 必须覆盖全部 AC}
**Architecture:** {2-3 句方案描述}
**Tech Stack:** {关键技术/库}

---
```

## Task Structure

```markdown
### Task N: {Component Name}

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`
- Test: `packages/api/src/path/test.ts`

**Step 1: Write the failing test**

\`\`\`typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("specificBehavior", () => {
  it("should do expected thing", () => {
    const result = functionUnderTest(input)
    assert.equal(result, expected)
  })
})
\`\`\`

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @multi-agent/api test`
Expected: FAIL with "functionUnderTest is not defined"

**Step 3: Write minimal implementation**

\`\`\`typescript
export function functionUnderTest(input: InputType): OutputType {
  return expected
}
\`\`\`

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Commit**

\`\`\`bash
git add packages/api/src/path/
git commit -m "feat: add specific feature [签名]"
\`\`\`
```

## Remember

- 写精确文件路径
- 计划中写完整代码（不是"加个验证"）
- 写精确命令 + 预期输出
- DRY, YAGNI, TDD, frequent commits

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 计划写"实现 XXX 功能" | 拆到具体文件、具体代码、具体测试 |
| 步骤产物后续要重写 | 每步产物在终态保留 |
| 探索性工作混在实现步骤里 | 显式标注 Spike（限时 + 产出是决策） |
| 一个步骤做太多事 | 每步 2-5 分钟，一个动作 |
| AC 没有逐条覆盖 | Plan Header 必须抄齐全部 AC |

## 下一步

计划写完 → **直接进入 `worktree`**（创建隔离开发环境）→ `tdd`（开始实现）。
