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
