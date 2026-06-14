# F030 Rich Blocks 只读卡片协议 Implementation Plan

**Feature:** F030 — `docs/features/F030-rich-blocks-readonly-cards.md`
**Goal:** agent 可声明式发送只读卡片，小孙感知：review 结论变成绿/黄/红卡片、AC 清单变成 checklist 视图。
**Acceptance Criteria:**
- AC1: CardBlock 支持 tone + fields，渲染组件按 tone 着色；现有 card 消费方不回归
- AC2: 新增 ChecklistBlock kind + 渲染组件（含勾选状态只读显示）
- AC3: agent 发卡片通道落地（MCP 工具 / 内联围栏，Design Gate 定）+ Zod discriminatedUnion 入口校验，非法 block 降级纯文本不崩渲染
- AC4: block 与消息/invocation 绑定 + 去重 + invocation 完成后拒迟到块（防挂错气泡，clowder F096 B4 教训）
- AC5: rich-messaging skill 写好 + manifest 注册 + 三 agent 挂载 + check:skills 过
- AC6: dogfood——一次真实 review 结论以卡片发出，小孙确认可读性提升

**Architecture:** agent 在消息正文里写 ```` ```cc_rich ```` 围栏 JSON（单轨通道，Design Gate 遗留 OQ 在此拍板，理由见下）。前端 `normalizeMessageToBlocks` 在渲染层解析围栏 → Zod（schema 在 `packages/shared`，F033 后端复用）校验 → 合法转 CardBlock/ChecklistBlock、非法原文保留为 markdown（fail-closed）。块内嵌于消息 content，与消息绑定是结构性的——不存在异步 attach 路径，"迟到块"按构造不可能（AC4 第三款的满足方式）。

**Tech Stack:** zod（新依赖，进 packages/shared）、vitest + @testing-library/react（F025 既有）、lucide-react（既有）。

---

## 通道决策（Design Gate 遗留技术 OQ，本 plan 拍板）

**结论：内联 `cc_rich` 围栏单轨；不新增 MCP 工具（推迟 F033）。**

| 候选 | 判定 | 理由 |
|------|------|------|
| MCP 工具（clowder 主轨） | ❌ 本期不做 | 我们 runtime 的 final assistant 消息自动持久化 + `post_message` 有 post-final lockout（mcp/server.ts:304-311）——review 结论恰恰是 final 消息，MCP 推送轨够不着 AC6 场景。交互卡片（F033）必须动后端时再上。 |
| 内联围栏（cc_rich 式） | ✅ 单轨 | final / progress(post_message) / a2a 消息全覆盖；历史回放、重连快照免费获得（content 即真相源）；块内嵌消息体 → AC4 防粘连按构造成立。 |
| 解析位置 | 前端 normalize 层 | DB content 原样持久化（含围栏原文），FTS/recall 不受影响；主渲染前端 normalize 层。未闭合 cc_rich 隐藏（r3 AC6，不显原文）、收尾转卡片；展示摘要面（折叠/侧栏/session-group）复用 `stripRichFencesForPreview`，涉少量后端 preview 改动——详见 feature doc 行为矩阵。 |

派生约束：解析仅对 `role === "assistant"` 消息生效（通道语义是 agent→小孙；用户粘贴围栏不触发渲染）。

## 协议规格（v1，schema 单一真相源 = packages/shared/src/rich-blocks.ts）

````markdown
先写 1-2 句自然语言，然后：

```cc_rich
{"id": "c1", "kind": "card", "title": "Review 通过", "tone": "success", "bodyMarkdown": "0 P1 / 0 P2，放行合入。", "fields": [{"label": "P1", "value": "0"}]}
```

```cc_rich
{"id": "cl1", "kind": "checklist", "title": "AC 进度", "items": [{"id": "i1", "text": "AC1 tone 着色", "checked": true}, {"id": "i2", "text": "AC6 dogfood", "checked": false}]}
```
````

校验规则（Zod discriminatedUnion on `kind`）：
- card: `id`(1-64) + `title`(1-200) 必填；`bodyMarkdown`≤4000；`tone` ∈ info/success/warning/danger；`fields` ≤12 项，label≤40/value≤200
- checklist: `id` + `items`(1-50) 必填，`title`(≤200) 可选；item: `id`(1-64)+`text`(1-200) 必填、`checked` 可选 bool
- 未知字段 strip（向前兼容），未知 kind / JSON 非法 / 超限 → **整段围栏原文保留为 markdown**（fail-closed，不崩渲染）
- 防粘连/去重（AC4）：同一消息内重复 `id` 只保留第一个；每消息 rich block 上限 8 个，超出的围栏降级原文；围栏未闭合（流式中）不产块；嵌套在其他代码围栏内的 `cc_rich` 不解析

---

## Task 0: 依赖与测试基建

**Files:**
- Modify: `packages/shared/package.json` — dependencies 加 `"zod": "^3.25.76"`
- Modify: `vitest.config.ts` — include 扩为 `["components/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"]`

**Step 1:** 上述两处修改 + `pnpm install`
**Step 2:** Run: `pnpm vitest run lib` → 预期 "no test files found" 之外无报错（include 生效）
**Step 3:** Commit `chore(F030): zod 依赖 + vitest 收 lib 测试 [黄仁勋]`

## Task 1: Zod schema（packages/shared/src/rich-blocks.ts）

**Files:**
- Create: `packages/shared/src/rich-blocks.ts`
- Modify: `packages/shared/src/index.ts` — `export * from "./rich-blocks"`
- Test: `lib/rich-blocks-schema.test.ts`（vitest alias 直指 shared src）

**Step 1: 失败测试** — 合法 card 通过、tone 非法拒绝、fields 超 12 拒绝、checklist items 空拒绝、未知 kind 拒绝、未知字段 strip
**Step 2:** Run: `pnpm vitest run lib/rich-blocks-schema.test.ts` → FAIL (module not found)
**Step 3: 实现**

```typescript
import { z } from "zod"

export const RichCardBlockSchema = z.object({
  kind: z.literal("card"),
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(4000).optional(),
  tone: z.enum(["info", "success", "warning", "danger"]).optional(),
  fields: z.array(z.object({ label: z.string().min(1).max(40), value: z.string().max(200) })).max(12).optional(),
})

export const RichChecklistBlockSchema = z.object({
  kind: z.literal("checklist"),
  id: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  items: z.array(z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(200),
    checked: z.boolean().optional(),
  })).min(1).max(50),
})

export const RichBlockSchema = z.discriminatedUnion("kind", [RichCardBlockSchema, RichChecklistBlockSchema])
export type RichCardBlock = z.infer<typeof RichCardBlockSchema>
export type RichChecklistBlock = z.infer<typeof RichChecklistBlockSchema>
export type RichBlock = z.infer<typeof RichBlockSchema>
```

**Step 4:** Run 同测试 → PASS；`pnpm --filter @multi-agent/shared typecheck` → PASS
**Step 5:** Commit `feat(F030): rich block Zod schema（card/checklist discriminatedUnion）[黄仁勋]`

## Task 2: 围栏解析器（lib/rich-content.ts）— AC3/AC4 核心

**Files:**
- Create: `lib/rich-content.ts`
- Test: `lib/rich-content.test.ts`

**Step 1: 失败测试**（核心用例清单，每条一个 it）
1. 纯文本无围栏 → 单 markdown 段
2. 文本 + cc_rich card → [markdown, card] 顺序保持（位置交错）
3. cc_rich 在普通 ``` 代码围栏内 → 不解析，原文保留
4. JSON 非法 / 未知 kind / tone 非法 → 围栏原文保留为 markdown（fail-closed）
5. 同消息两个同 id card → 第二个丢弃（去重）
6. 9 个 block → 第 9 个降级原文（上限 8）
7. 未闭合围栏（流式半截）→ 未闭合 cc_rich 隐藏（r3 AC6 改：前导留、围栏源码不显，不依赖流式态）；未闭合普通围栏 → 原文保留
8. checklist 合法 → ChecklistBlock 段
9. ~~~ tilde 围栏内的 cc_rich → 不解析

**Step 2:** Run: `pnpm vitest run lib/rich-content.test.ts` → FAIL
**Step 3: 实现** — 行扫描器跟踪围栏状态（``` / ~~~，开栏 tag 记录），仅顶层 `cc_rich` 段捕获；`JSON.parse` + `RichBlockSchema.safeParse`；产出 `RichSegment[] = (MarkdownBlock | CardBlock | ChecklistBlock)[]`，相邻 markdown 段合并

```typescript
import { RichBlockSchema } from "@multi-agent/shared"
import type { Block, CardBlock, ChecklistBlock, MarkdownBlock } from "./blocks"

const MAX_RICH_BLOCKS_PER_MESSAGE = 8
export type RichSegment = MarkdownBlock | CardBlock | ChecklistBlock

export function parseRichSegments(content: string): RichSegment[] {
  // 行扫描：顶层 ```cc_rich 围栏捕获 JSON；其他围栏只做状态跟踪。
  // 失败路径（闭合但 JSON 非法/超限）把围栏原文拼回 markdown（fail-closed）；
  // 未闭合 cc_rich → 隐藏（r3 AC6，见 feature doc 行为矩阵）。
  // 去重：同 id 保留第一个；超过 MAX 后全部降级原文。
  ...
}
```

**Step 4:** Run → PASS
**Step 5:** Commit `feat(F030): cc_rich 内联围栏解析器 — 顶层捕获/fail-closed/去重/上限 [黄仁勋]`

## Task 3: Block 类型 + normalize 接线

**Files:**
- Modify: `lib/blocks.ts` — 加 `ChecklistBlock` type、`Block` union 扩展；`normalizeMessageToBlocks` 的 content 分支：assistant 消息走 `parseRichSegments`，user 消息保持单 markdown
- Test: `lib/blocks.test.ts`

**Step 1: 失败测试** — assistant 消息含围栏 → card 块出现；user 消息含同样围栏 → 仍是单 markdown；无围栏 assistant 消息 → 行为不变（回归）；thinking/image 块顺序不受影响
**Step 2:** FAIL → **Step 3: 实现** → **Step 4:** PASS + `pnpm vitest run components`（既有组件测试回归）
**Step 5:** Commit `feat(F030): ChecklistBlock kind + normalizeMessageToBlocks 接 cc_rich 解析（assistant only）[黄仁勋]`

## Task 4: ChecklistBlock 渲染组件（AC2）

**Files:**
- Create: `components/chat/rich-blocks/checklist-block.tsx`
- Modify: `components/chat/block-renderer.tsx` — 加 `case "checklist"`
- Test: `components/chat/rich-blocks/checklist-block.test.tsx`

**Step 1: 失败测试** — title 渲染、checked 项带勾选图标+muted 样式、未勾选项普通样式、无 title 不渲染标题行、进度计数（如 "2/5"）
**Step 3: 实现** — lucide `CheckCircle2`/`Circle` 图标，只读（无 onClick/input），视觉对齐现有 card-block 风格
**Step 5:** Commit `feat(F030): ChecklistBlock 只读渲染组件 + renderer 接线 [黄仁勋]`

## Task 5: CardBlock tone/fields 渲染测试补齐（AC1 回归保障）

**Files:**
- Test: `components/chat/rich-blocks/card-block.test.tsx`（新建——现无测试）

四 tone 着色断言 + 缺省 tone=info + fields 键值对渲染 + bodyMarkdown 渲染 + block-renderer card case 回归。组件本身已具备 tone/fields（F001/F012 产物），不动实现，只补契约测试锁行为。
Commit `test(F030): CardBlock tone/fields 契约测试锁定（AC1）[黄仁勋]`

## Task 6: rich-messaging skill（AC5）

**Files:**
- Create: `multi-agent-skills/rich-messaging/SKILL.md`
- Modify: `multi-agent-skills/manifest.yaml` — skills 加 rich-messaging 条目（triggers/agents 三家/next []）
- Modify: `multi-agent-skills/BOOTSTRAP.md` — 计数 15→16 + 表格加行
- Run: `pnpm mount-skills`（三 CLI 目录 symlink）+ `pnpm check:skills` → 0 error

SKILL.md 内容要点（对照 clowder rich-messaging 改写为我们的单轨协议）：两种 block 规格 + cc_rich 围栏精确格式 + 何时用（review 结论/AC 清单/3+ 结构化信号）+ 三纪律（先 1-2 句文字后块 / 不确定就纯文本 / 只读不交互-交互等 F033）+ 常见错误表（kind 不是 type / 围栏必须顶层 / id 唯一 / JSON 必须合法单对象）。
Commit `feat(F030): rich-messaging skill + manifest + BOOTSTRAP + 三 agent 挂载 [黄仁勋]`

## Task 7: feature doc 决策落盘

Design Decisions 表更新：通道=内联 cc_rich 单轨（MCP 轨推迟 F033，理由 post-final lockout）；AC4 迟到块=按构造不可能 + 测试锁定；解析层=前端 normalize。Timeline 加行。
Commit `docs(F030): Design Decisions 通道拍板 + plan 落盘 [黄仁勋]`

## Task 8: 收尾链

1. `quality-gate`：`pnpm typecheck` + `pnpm vitest run` + `pnpm check`（skills+docs+adr004）+ 全量回归
2. `pnpm worktree:preview` 起 F024 动态端口，dogfood 数据就位（AC6 准备：preview 房间触发一次真实 agent turn 以卡片发 review 结论）
3. `acceptance-guardian` 零上下文验收 AC1-AC5
4. `requesting-review` @德彪（真 codex：`cat prompt.txt | codex exec -s read-only`，含 worktree 路径 + commit 链 + AC 对照）
5. `receiving-review` 修到 GO
6. **停**：AC6 + 合 dev 等小孙明早 worktree 验收（家规红线）
