# Lessons Learned

> 目的：沉淀可复用、可验证、可追溯的教训，避免重复踩坑。  
> 导入目标：作为 Hindsight 的稳定知识入口之一（P0/P0.5）。 

---

## 1) ID 规则

- 格式：`LL-XXX`（三位数字，递增）
- 稳定性：已发布 ID 不重排、不复用
- 状态：`draft | validated | archived`
- 变更：重大改写保留同一 ID，并在条目中记录 `updated_at` 与变更原因

---

## 2) 条目模板（7 槽位）

```markdown
### LL-XXX: <教训标题>
- 状态：draft|validated|archived
- 更新时间：YYYY-MM-DD

- 坑：<一句话描述踩了什么坑>
- 根因：<为什么会踩>
- 触发条件：<在什么条件下会复发>
- 修复：<当时怎么修>
- 防护：<可执行机制；规则/测试/脚本/流程>
- 来源锚点：<文件路径#Lx | commit:sha | review-notes/doc 链接>
- 原理（可选）：<第一性原理；必须由真实失败案例支撑>

- 关联：<ADR / bug-report / 技能 / 计划文档>
```

---

## 3) 质量门槛（入库前必过）

1. 有来源锚点：至少 1 个可追溯锚点，推荐 2 个（规则 + 实例）。
2. 有时效性验证：确认未被后续 addendum / mailbox 讨论推翻。
3. 有可执行防护：不能只写“注意”，必须有可执行动作。
4. 原理槽位约束：没有真实失败案例支撑，不写原理。
5. 去重：同类教训合并，避免“同义多条”。

---

## 4) 知识条目

### LL-001: 提炼教训前先做时效性验证
- 状态：validated
- 更新时间：2026-02-13

- 坑：直接从旧文档提炼规则，忽略后续 addendum，导致导入过时结论。
- 根因：把“文档存在”误当成“结论仍有效”，缺少时效性检查环节。
- 触发条件：高频讨论期（同一主题 3 天内多次更新）或 ADR 后续附录新增时。
- 修复：在提炼流程前增加时效性检查清单，并要求至少核对一次 mailbox 更新。
- 防护：将时效性检查写入提炼标准；未通过检查的条目不得进入 P0 导入集。
- 来源锚点：
  - `docs/decisions/005-hindsight-integration-decisions.md#L297`
- 原理（可选）：知识沉淀是“状态同步问题”，不是“文档搬运问题”；任何结论都依赖其最新上下文状态。
- 关联：`docs/decisions/005-hindsight-integration-decisions.md`

### LL-002: 严禁在 Worktree 或局部任务中运行全量格式化
- 状态：validated
- 更新时间：2026-04-04

- 坑：在执行局部 UI 优化时运行 `pnpm format`，导致 90+ 个无关历史文件被重刷风格，严重污染 Review 界面。
- 根因：误以为工具作用域受限于 worktree 子目录，实则 `biome` 或 `pnpm` 脚本默认作用于整个 Git 仓库根目录；且未意识到历史代码库存在大量风格不一致问题。
- 触发条件：在包含历史遗留风格问题的多包（Monorepo）仓库中，未指定路径直接执行自动化修复命令。
- 修复：回滚 worktree 内所有受污染文件 (`git checkout -- .`)，仅对手术级修改的文件进行局部重写和格式化。
- 防护：禁止在非重构专项任务中运行全站级 `format`。修复 lint 时必须显式指定文件路径，例如：`npx @biomejs/biome check --write path/to/file`。
- 来源锚点：
  - `docs/lessons/lesson.md#LL-002`（即本条目）
  - 本次任务的 Review 反馈记录（范德彪 & 黄仁勋）
- 原理（可选）：自动化工具的“爆炸半径”必须被显式控制。在协作开发中，保持 Diff 的“高信噪比”是维护团队信任的核心。
- 关联：`ui-optimization-plan.md`, `GEMINI.md` (工程标准部分)

### LL-003: 排查 Bug 从"症状名"出发 vs 从"动作发起者"出发
- 状态：validated
- 更新时间：2026-04-11

- 坑：B003 首轮修复选错战场——改 `manifest.yaml` triggers + 给 `feat-lifecycle/SKILL.md` 加"阶段路由"章节 + 补 6 条 registry 测试，37 绿后 commit 79468a0。真 bug 在 `message-service.ts:1220-1247` 的 `prependSkillHint()` 往 prompt 注入 `⚡ 匹配 skill: feat-lifecycle` 让 agent 反复重读 SKILL.md——首轮动过的 4 个文件无一是现场。
- 根因：把 bug 报告里出现的名字（feat-lifecycle）当成了动作发起者。skill 文件是被动定义，不会自己命令 agent 加载自己，一定有上游代码构造"加载 skill"的指令，那才是 actor。没问"谁发起了这个动作"，直接冲去改同名文件。四个独立可避免的子错：
  1. 没 grep 症状字符串 `⚡ 匹配 skill` 的生产者——一条 grep 就落到 `prependSkillHint`。
  2. 没从 `handleMessage` 入口追调用链——3 跳全在本 repo。
  3. 没 grep 要动的函数名——漏掉 `message-service.ts:1356-1358` 前人留的同机制踩坑注释。
  4. TDD 写在了 `registry.match()` 的 policy 层，不是 `prependSkillHint()` 的 behavior 层，绿的是自己画的靶子。
- 触发条件：bug 报告里的名字恰好对应仓库里某个同名配置/文档文件，被动定义文件是强诱饵。
- 修复：soft-reset 79468a0，restore 首轮动过的 3 个文件，在真现场 `message-service.ts` 新增 `LINEAR_FLOW_SKILLS` 过滤 + `matchOrthogonalSkills()`，回归测试写在 `message-service-skill-hint.test.ts`（直接断言 hint 层输出）。
- 防护：
  1. 症状字符串的生产者永远是第一条 grep——改任何 config 前先 grep 这个字符串由哪段代码写出来。
  2. 列不出 actor 代码位置（带行号）不准进 Phase 4；skill/config/doc 是被动方，actor 一定在 `services/` 或 `runtime/`。
  3. 要改的函数名必须全仓回溯，扫所有 caller 和注释——前人常在附近留同机制踩坑注释。
  4. 回归测试断言"用户可观测输出"（hint 层字符串），不是 policy 层的 `match()` 结果。自问"这个断言真失败了等于用户看到 bug 吗？"。
  5. 提交前 pre-mortem："fix 合进去 bug 没消失，Plan B 是什么？"——答不上来 = 没找到根因，回 Phase 1。
- 来源锚点：
  - `packages/api/src/services/message-service.ts:611,1220-1247,1356-1358`
  - `docs/bugReport/B003-feat-lifecycle-double-entry.md`
  - 错误 commit 79468a0（已 soft-reset）/ 正确 commit caf43fd
- 原理（可选）：调试的最小单位是"动作 → 执行者"，不是"文件"或"配置"。被动定义文件只在被运行时代码读取时才参与 bug；从症状名直接跳到同名文件是把名字巧合当因果关系。
- 关联：`docs/bugReport/B003-feat-lifecycle-double-entry.md`, `multi-agent-skills/debugging/SKILL.md`, `multi-agent-skills/tdd/SKILL.md`

### LL-004: 同类症状在同一层反复打补丁仍复发 → 根因一定在上一层
- 状态：validated
- 更新时间：2026-04-11

- 坑：F003 之前对"A2A 不收敛 / 流程不推进 / 会话截断"反复在 skill 文本、prompt 模板、settlement 状态机三个层面打补丁，每次都看起来"修好了"但症状总复发。真相是 A2A 管线本质是 pull-based 的文本扫描（靠正则扫 CLI stdout 里的行首 `@alias`），三个症状都是这个模型的必然失效——无论上层 skill / prompt 写得多完备都无法掩盖底层表达力不足。
- 根因：在错误的层修 bug，会每次都"看起来修好了"一阵子——因为具体 case 的文本能对上。但同类 case 换个表述/时机就复发。把"这次能过"当成"根因找到了"。skill/prompt 是被动配置；真正决定流程走向的执行代码在 runtime 层。
- 触发条件：
  1. 同一类症状报告过 ≥2 次，每次修的都是描述层面（文案/参数/阈值）。
  2. 修复 PR diff 主要集中在 `multi-agent-skills/`、prompt 字符串、或单一 switch 分支。
  3. Reviewer 看代码说不出"这次和上次修的本质区别是什么"。
- 修复：把问题上抛一层——`A2A 不收敛 → dispatch.ts 没有消费 parentInvocationId → 新增 A2AChainRegistry + 回程派发`、`流程不推进 → SopTracker 只 setState 不派发 → SopAdvancement 承载 nextDispatch + planForcedDispatch`、`会话截断 → extractFinalText 只看 exitCode 不看 stop_reason → 三 runtime parseStopReason + 续写循环`。F003 的 4 个 Phase 都是"上抛一层"的具体化。
- 防护：
  1. 同一症状族第 2 次打补丁前，先开 discussion 问"我在哪一层修？上一层是什么？"——一句话答不上来 = 还没找根因。
  2. 报告模板新增槽位"过去修复历史"：累计 ≥2 次未根治 → 强制上抛一层讨论。
  3. 每个 bug fix commit message 必须写"这次修的 layer"（runtime / orchestrator / skill / prompt），方便后续 grep 同层反复。
  4. Architecture-level 改动必须引用**至少一个 reference implementation**（F003 引了 clowder-ai 的 WorklistRegistry），防止在真空中设计。
- 来源锚点：
  - `docs/features/F003-a2a-convergence.md#根因（架构级，一句话）`
  - commit `1a018d4 feat(F003): A2A 运行时闭环 ...`
  - 历史补丁对比：B003（feat-lifecycle 双重进入）/ B004（settlement premature）都曾被当成"另一个独立 bug"修，实际是同一根因的外层表现
- 原理（可选）：每个抽象层都有一个"表达力上限"——超出就靠下层表达力硬撑。反复在同一层修同类问题，等于在该层的表达力上限处打补丁。打补丁的次数是根因距离的度量：第 3 次打补丁意味着至少要上抛 1 层。
- 关联：`docs/features/F003-a2a-convergence.md`, `docs/bugReport/B001-B004`（同一 A2A 症状族的历次补丁）, `multi-agent-skills/self-evolution/SKILL.md`
