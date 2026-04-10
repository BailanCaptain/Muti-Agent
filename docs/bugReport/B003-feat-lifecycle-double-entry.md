# B003 — 黄仁勋 在同一个任务里进入了两次 feat-lifecycle

> 状态：fixed — 待手工验证
> 报告日期：2026-04-11
> 报告人：小孙（现场观察，2026-04-10 会话复盘时提出）
> 处理人：黄仁勋
> Related: —

---

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **现象** | 给黄仁勋一个 feature 任务，在同一条对话流里，`feat-lifecycle` skill 被重新加载/执行了**两次以上**。预期只在开头 kickoff 进一次、收尾 completion 进一次，mid-flow 不应再触发。 |
| 2 | **证据** | 小孙 2026-04-10 开场原话："黄仁勋进入了两次 feat-lifecycle，为什么"。 |
| 3 | **第一轮假设（错误）** | ~~triggers 列表含 `bugfix`/`重构`/`开发任务`/`feat` 四个过度泛化词 → 收紧 triggers + 在 SKILL.md 加阶段路由门。~~ |
| 4 | **第一轮假设被驳回** | 小孙反问："我们的 skill 很大程度 copy 自 clowder-ai，triggers 几乎一样，为什么他们没有这个问题？去读源码。"对照 `reference-code/clowder-ai/` 后证实 triggers 不是根因。 |
| 5 | **真正的根因（H-final）** | `packages/api/src/services/message-service.ts` 的 `prependSkillHint()` / `buildSkillHintLine()` 在**每条用户消息**上跑 `SkillRegistry.match()`（朴素 `.includes()` 关键词子串匹配），把命中的 skill 名写成 `⚡ 匹配 skill: feat-lifecycle — 请加载并按 skill 流程执行。` 注入到 prompt 头部。agent 看到 `⚡ 加载 skill` 就重新加载 SKILL.md 全文 → 从头走 kickoff。这个**注入层是我们独有的**，clowder-ai 没有。 |
| 6 | **diagnostic 策略** | 1) 比较 `reference-code/clowder-ai/packages/api/src/routes/skills.ts` 和 `SystemPromptBuilder.ts`，确认 clowder 是否有等价的 skill-hint 注入逻辑。<br>2) 搜索本仓库所有 `registry.match()` 调用点，区分"给 agent 看的建议"和"检测 agent 正在运行哪个 skill"（后者必须保留）。<br>3) 在 message-service.ts:1218-1247 定位注入点。 |
| 7 | **超时策略** | 若 30 分钟内判定不了注入层 vs. 触发词孰对孰错 → 升级为架构讨论。 |
| 8 | **用户可见修正** | 无——agent 行为问题，不丢数据。 |
| 9 | **验收** | mid-flow 消息（"这个 bugfix 我先 TDD 一下"、"重构一下"、"准备合入"）绝不再 `prependSkillHint` 出线性链 skill；同时 `/merge`、`/feat` 等 slash 命令仍然工作，`advanceSopIfNeeded` 仍然能在 agent 输出里检测到 tdd/quality-gate/... 完成以推进 SOP。 |

---

## 五件套

### 1. 报告人 / 发现场景

小孙在 2026-04-10 会话复盘时把这列为 6 个 bug 之一："黄仁勋进入了两次 feat-lifecycle，为什么"。从 trace 上看，同一任务里 feat-lifecycle skill 被加载/执行了多次。

### 2. 复现步骤

**期望行为**：

- 一个 feature 任务里，`feat-lifecycle` 最多出现两次：一次 kickoff（开头）、一次 completion（merge 后回指）。
- mid-flow 消息（TDD 中、review 中、修 bug 中）绝不再触发 `⚡ 加载 skill: feat-lifecycle` 注入。

**实际行为（首轮复盘后定位的执行路径）**：

1. `MessageService.handleMessage()` 收到用户消息 → 调用 `prependSkillHint(content, provider)`（message-service.ts:611-612）。
2. `prependSkillHint` 调用 `SkillRegistry.match(content, provider)`（registry.ts）。
3. `match()` 用 `lower.includes(trigger.toLowerCase())` 做朴素子串匹配，**没有任何会话状态/SOP 阶段感知**。
4. 任何包含 `bugfix` / `重构` / `开发任务` / `feat` 的消息都会把 feat-lifecycle 当成命中项返回。
5. `prependSkillHint` 把 `⚡ 匹配 skill: feat-lifecycle — 请加载并按 skill 流程执行。` 贴到消息前发给 CLI。
6. agent 看到 hint → 加载 `feat-lifecycle/SKILL.md` 全文 → 从 `## 核心知识` 开始通读 → 被当成 kickoff 重新执行。
7. 叠加 `merge-gate.next: ["feat-lifecycle"]` 合法 completion 回指，一个任务里就出现 ≥2 次进入。

### 3. 根因分析（第二轮，对照 clowder-ai 源码后定论）

**第一轮我得出的根因是错的：** 我以为是 triggers 太泛化 + SKILL.md 缺阶段门，在 commit 79468a0 里收紧了 manifest triggers 并给 SKILL.md 加了"阶段路由"章节。

**小孙打回的一句话：**
> "我看你改了 skill 的 trigger 和一些描述，你确定这是根因吗？我们的 skill 很大程度是 copy 的 clowder-ai 的，trigger 几乎一样，为什么他们不会有这样的问题呢？我觉得你需要再去读读源码。"

**去读 clowder-ai 源码的结果：**

| 项 | clowder-ai | Multi-Agent（我们）|
|----|-----------|-------------------|
| feat-lifecycle triggers | `开个新功能` / `new feature` / `F0xx` / `立项` / `feature 完成` / `F0xx done` / `验收通过` / `讨论新功能需求` | 几乎完全一样（`新功能` / `bugfix` / `重构` / `开发任务` / `feat` / `立项` / ...）|
| 用户消息上跑 `registry.match()` 做关键词注入？ | **没有** | **有**（`message-service.ts:1220 prependSkillHint`）|
| triggers 的运行时用途 | **只用于 dashboard 展示**（`packages/api/src/routes/skills.ts:160-247`），无 runtime `.includes()` |朴素 `.includes()` 子串匹配 + 结果写入用户 prompt |
| skill 发现机制 | Claude CLI native progressive disclosure（agent 自己看 description 决定是否加载全文）|  `⚡ 加载 skill: xxx` 预置 hint 强制加载 |
| SOP 阶段感知 | `SystemPromptBuilder.ts:591-596` `sopStageHint`（"bulletin board, not controller"）+ `promptTags` 里 `skill:` 显式标签 | 有 `SopTracker` 但 `prependSkillHint` 根本不读它 |

**结论**：clowder-ai 没有我们这层 `prependSkillHint` 注入逻辑，所以 triggers 写成什么样都不会造成"同一任务反复进 feat-lifecycle"的问题——他们靠 Claude CLI 原生的渐进披露，agent 在 mid-flow 消息上根本不会主动去重读 feat-lifecycle/SKILL.md。

**我们独有的 bug 源头**就是 `message-service.ts:1220-1247` 这两个方法：

```typescript
private prependSkillHint(content: string, provider: Provider): string {
  if (!this.skillRegistry) return content
  const slashSkill = this.skillRegistry.matchSlashCommand(content)
  if (slashSkill) { /* slash 走显式路径，OK */ }
  const matched = this.skillRegistry.match(content, provider)  // ← 朴素 includes
  if (!matched.length) return content
  const names = matched.map((m) => m.skill.name).join(", ")
  return `⚡ 匹配 skill: ${names} — 请加载并按 skill 流程执行。\n\n${content}`  // ← 注入
}
```

`registry.match()` 本身不知道当前 SOP 跑到哪一步；给它一句 "这个 bugfix 我先 TDD 一下" 就会同时命中 `feat-lifecycle`（因为 `feat`/`bugfix`）、`tdd`、`debugging`——然后全部写成 hint 贴到 prompt 前面，agent 当真去加载。

**冒烟证据**（代码里就有前人留的注释，承认同样的机制已造成过问题）——`message-service.ts:1356-1358`：

```
// Don't prependSkillHint: Phase 1 header already says "参考 skill:
// collaborative-thinking（不要加载全文，按本 header 执行）" — a ⚡ 加载 skill
// line on top would contradict that and make agents load the full SKILL.md.
```

前人在并行思考入口显式绕过了 `prependSkillHint`，说明这个注入层早就被发现会让 agent 误加载 SKILL.md——但没做结构性修复。

**为什么线性链 skill 需要特殊对待**：`feat-lifecycle → writing-plans → worktree → tdd → quality-gate → vision-guardian → requesting-review → receiving-review → merge-gate` 这 9 个 skill 是**开发流程链**，它们的推进是**有状态的**（必须按顺序，一次 commit 一步），应该由 (a) 小孙的 `/slash` 显式命令 或 (b) `SopTracker.advance()` 沿 `next` 链状态机推进，**绝不能由 user 消息里随手出现的关键词触发**。

反之，`debugging` / `self-evolution` / `collaborative-thinking` / `cross-role-handoff` 这 4 个 skill 是**正交的 mid-flow 工具**——用户任何时候说"有个 bug"、"我们讨论一下"、"交接给范德彪"，都应该立即路由过去。它们本来就是用来**打断**线性流程的，关键词注入对它们是正确行为。

### 4. 修复方案

**真正的修复在 `packages/api/src/services/message-service.ts`**：

1. **新增常量 `LINEAR_FLOW_SKILLS`**（导出，供测试复用）——列出 9 个线性流程 skill。
2. **新增私有方法 `matchOrthogonalSkills(content, provider)`**——调用 `registry.match()` 然后过滤掉 `LINEAR_FLOW_SKILLS`，只返回正交 skill 的名字。
3. **`prependSkillHint()` 改造**：slash 命令分支保持不变（显式意图，始终允许）；关键词匹配分支改用 `matchOrthogonalSkills()`。
4. **`buildSkillHintLine()` 同样改造**（它是 `prependSkillHint` 的 Phase 2 变体，同一个 bug）。
5. **`advanceSopIfNeeded()` 保持不动**——它跑在 assistant 输出上，用 `registry.match()` 原样检测"刚才 agent 执行了哪个 skill"，这是状态机正确行为，不能过滤。

**不改的文件**：
- `multi-agent-skills/manifest.yaml` — triggers 保持原样（和 clowder 对齐）。
- `multi-agent-skills/feat-lifecycle/SKILL.md` — 不加"阶段路由门"（那是第一轮错误方案的残留，argument-hint 本来就已经在 frontmatter 里支持 `[阶段: kickoff|completion]`）。
- `packages/api/src/skills/registry.ts` — `match()` 继续做朴素 `.includes()`，因为它需要服务多个 caller（`prependSkillHint` 要过滤线性 skill，但 `advanceSopIfNeeded` 需要看到全部匹配）。

**备选方案（放弃理由）**：

- ~~收紧 manifest triggers / 给 SKILL.md 加 Phase Router 章节（B003 第一轮错误方案）~~：没有修根因，clowder 用一样的 triggers 不出问题证明了这一点。triggers 和 SKILL.md 内容都是**给 agent 自己在 SKILL.md 被加载时读的指引**，不能阻止"上游把 SKILL.md 注入到 prompt"这件事。
- ~~把 `SopTracker` 状态注入 `registry.match()`~~：架构复杂度大，而且 `match()` 有多个 caller 语义不同（user 消息 vs. assistant 输出），混合状态会更混乱。当前方案在 caller（message-service）层加一个薄过滤器 ROI 更高。
- ~~完全删除 `prependSkillHint`，学 clowder 靠 Claude CLI native 发现~~：我们不是所有 provider 都走 Claude CLI（还有 codex、gemini），它们不一定有对等的 skill discovery；保留 orthogonal skill 的关键词路由对 codex/gemini 仍有价值。

### 5. 验证方式

**新增回归测试**（`packages/api/src/services/message-service-skill-hint.test.ts`，11 条）：

| # | 测试 | 断言 |
|---|------|------|
| 1 | `"这个 bugfix 我先 TDD 一下"` | ✖ feat-lifecycle，✖ tdd |
| 2 | `"重构这段代码"` | ✖ feat-lifecycle |
| 3 | `"这个 feat 快做好了"` | ✖ feat-lifecycle |
| 4 | `"我现在开始开发这个模块"` | ✖ worktree |
| 5 | `"改完了准备合入主干"` | ✖ merge-gate |
| 6 | `"遇到一个 bug 需要修复"` | ✔ debugging（正交必须保留）|
| 7 | `"我又犯了同样的错误"` | ✔ self-evolution |
| 8 | `"我们一起讨论一下架构"` | ✔ collaborative-thinking |
| 9 | `"帮我做一次交接"` | ✔ cross-role-handoff |
| 10 | `registry.match("用 TDD 方式来做")` | ✔ tdd（registry 层不过滤，advanceSopIfNeeded 仍需要）|
| 11 | `LINEAR_FLOW_SKILLS` 集合覆盖完整 | 9 条线性 skill 全在集合内，4 条正交 skill 全不在 |

**运行结果**：

```
pnpm exec tsx --test src/services/message-service-skill-hint.test.ts
→ ℹ tests 11  ℹ pass 11  ℹ fail 0

pnpm exec tsx --test src/skills/registry.test.ts src/services/message-service.test.ts
→ ℹ tests 46  ℹ pass 46  ℹ fail 0
```

**手工验证（等小孙现场复验）**：

1. 启动一个 feature 任务，完整走一遍 feat-lifecycle(kickoff) → writing-plans → worktree → tdd → quality-gate → vision-guardian → requesting-review → receiving-review → merge-gate → feat-lifecycle(completion)。
2. 检查 trace：`⚡ 匹配 skill:` 只应在 kickoff / completion 两处出现；中间每一条普通用户消息都不再出现 `feat-lifecycle` 注入。
3. 中途发"这个 bugfix 我先 TDD 一下"一类 mid-flow 消息 → trace 里**不应**看到 `⚡ 匹配 skill: feat-lifecycle`；但如果消息里含"bug"，应该还能看到 `⚡ 匹配 skill: debugging`（这是正确的正交行为）。
4. 发 `/merge` → 仍应看到 `⚡ 加载 skill: merge-gate`（slash 命令显式路径不受过滤器影响）。

---

## 附：第一轮错误修复（commit 79468a0）的反思

**过错**：没有对比 clowder 就下"收紧 triggers + 加 SKILL.md 阶段门"的结论。triggers 在我们仓库里跟 clowder 的大同小异，如果 triggers 真是根因，clowder 早就炸了。小孙的质疑是对的——我跳过了**找到独有差异**这一步。

**教训**：改 skill 配置前，先问"上游 clowder 怎么做的、为什么他们不出问题"。不是所有 bug 都能通过改 skill 定义修复，有时候 bug 在**上游的编排层**（如 `prependSkillHint`），skill 本身是清白的。

**撤销**：commit 79468a0 已在本地 soft-reset 丢弃；manifest.yaml / feat-lifecycle/SKILL.md / registry.test.ts 已回到 7863f8d 的状态；B003 报告本身保留但整份重写为当前内容。
