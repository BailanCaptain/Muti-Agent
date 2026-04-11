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

### LL-003: 排查 Bug 时从"症状名"出发 vs 从"动作发起者"出发
- 状态：validated
- 更新时间：2026-04-11

- 坑：B003（feat-lifecycle 双重进入）第一轮修复完全选错了战场——收紧了 `multi-agent-skills/manifest.yaml` 的 triggers、在 `feat-lifecycle/SKILL.md` 加了"阶段路由"章节、给 `registry.test.ts` 补了 6 条测试，全部 37 绿，然后把 79468a0 commit 出去了。真正的 bug 在 `packages/api/src/services/message-service.ts:1220-1247` 的 `prependSkillHint()` 往 prompt 注入 `⚡ 匹配 skill: feat-lifecycle` 导致 agent 反复重读 SKILL.md；首轮修复里的四个文件没有一个是 bug 现场。
- 根因：**我把 bug 报告里出现的名字（feat-lifecycle）当成了"动作发起者"**。小孙描述的是"黄仁勋进入了两次 feat-lifecycle"——我直接打开了 feat-lifecycle 的 SKILL.md 和 manifest 去找破绽，完全没问"是谁告诉 agent 去进入 feat-lifecycle 的？"。**skill 文件是被动的定义，它自己不会命令 agent 加载自己**；一定有上游代码在构造"加载 skill"的指令，那才是 actor。我跳过了这一问，把被动方当成了主动方。由此衍生出 4 个本可以独立避免的子错误：
  1. **没 grep 症状文本的生产者**：agent 看到的是 prompt 里的"⚡ 匹配 skill: xxx"，这个字符串模板只在本仓库的一个地方被写出来（`message-service.ts:1233`）。一条 `grep "⚡ 匹配 skill"` 就能落到 `prependSkillHint` 门口，但我没有搜。
  2. **没追调用链**：`packages/api/src/services/message-service.ts:611` 在 `handleMessage` 里就显式 `const effectiveContent = this.prependSkillHint(...)`——从"user 消息进入" 到"agent 收到 prompt"只有 3 跳，全在本 repo。我没从入口往下走一遍。
  3. **现场已有同类案发记录，我没 grep 到**：`message-service.ts:1356-1358` 留着前人的注释 `Don't prependSkillHint: ... a ⚡ 加载 skill line on top would contradict that and make agents load the full SKILL.md`——同一个机制造成同一种错误加载的证据，写得清清楚楚。一条 `grep prependSkillHint packages/api/` 就能命中。我没搜。
  4. **TDD 写在了错的抽象层**：我给新的"收紧 triggers"补的 6 条测试全是 `registry.match("xxx")` 层的断言——测的是我自己刚定义的策略（"这个字符串不应该命中 feat-lifecycle"），而不是用户可观测的行为（"这条消息经过完整管道后，agent 看到的 prompt 里不应出现 `⚡ 匹配 skill: feat-lifecycle`"）。绿得飞起，但绿的是我自己画的靶子；bug 的现场——`prependSkillHint` 的输出——根本没被任何测试覆盖。这是 tdd skill 明文反对的"手工验证 + 事后补测"的变种：测试的验证目标不是 bug 本身，是我假设的 bug。
- 触发条件：bug 报告里出现了一个具体的 skill / 模块 / 文件名（"X 进了两次"、"Y 不工作"），而且这个名字恰好对应仓库里有一个同名的配置或文档文件。被动定义文件的存在是一个强诱饵，很容易让人跳过"actor 是谁"这一步。
- 修复：整体反转——soft-reset 掉 79468a0，把 manifest.yaml / feat-lifecycle/SKILL.md / registry.test.ts 三份文件 restore 回 clean state，在真正的 bug 现场（`message-service.ts`）新增 `LINEAR_FLOW_SKILLS` 过滤 + `matchOrthogonalSkills()`，新加回归测试写在 `packages/api/src/services/message-service-skill-hint.test.ts`（用 `LINEAR_FLOW_SKILLS` 直接测 hint 层输出）。两个 commit：bug6 一个、B003 一个。
- 防护（强制动作，不是"注意"）：
  1. **"症状字符串的生产者"永远是第一条 grep**。bug 报告里出现的任何具体字符串/前缀/关键短语（如 `⚡ 匹配 skill`、`进入了两次 xxx`、任何 prompt 片段），在动 config 之前必须先 `grep` 这个字符串在仓库里由哪段代码写出来，落到那段代码再开工。
  2. **症状名 ≠ actor 名**。写诊断胶囊 Phase 1 的 `现象` 栏位时，强制附加一句"谁发起了这个动作？"。skill / 配置 / 文档 / schema 类文件是被动定义，不会自己发起动作——actor 一定是运行时代码（`services/` 或 `runtime/` 下）。如果列不出 actor 的代码位置（带行号），不准进入 Phase 4 修复。
  3. **Grep 命中的函数名必须全仓回溯**。确定要改某个函数（如 `prependSkillHint`）之前，先 `grep <函数名>` 整个 repo，把所有 caller 和注释扫一遍——前人常在附近写过同类 bug 的踩坑注释（本 case 就有，三行注释明文写着同一个机制）。没扫完不准改。
  4. **回归测试必须写在"用户可观测"那一层**。bug 修复的 failing test 必须复现**用户看到的现象**（或用户代理：agent prompt 输出），不是我假设的 policy。写测试前自问"这个断言真的失败就等于用户看到 bug 吗？"——如果否，测试层级错了，重写。`registry.match("xxx") not includes "yyy"` 是 policy 断言；`prependSkillHint("xxx") not includes "⚡ 匹配 skill: yyy"` 才是 behavior 断言。
  5. **提交前 pre-mortem**："如果这个 fix 合进去之后 bug 没消失，我的 Plan B 是什么？"——答不上来 = 没找到根因，回 Phase 1 重来。这条写进 quality-gate 清单。
- 来源锚点：
  - `packages/api/src/services/message-service.ts:611`（actor 调用点）
  - `packages/api/src/services/message-service.ts:1220-1247`（actor 定义：`prependSkillHint` / `buildSkillHintLine`）
  - `packages/api/src/services/message-service.ts:1356-1358`（前人留的同类案发注释，grep 就能命中）
  - `docs/bugReport/B003-feat-lifecycle-double-entry.md`（含首轮错误方案的反思章节）
  - 错误 commit：79468a0（本地 soft-reset 丢弃，未推送）
  - 正确 commit：caf43fd（真修复 + 回归测试）
- 原理（可选）：调试的最小单位不是"文件"也不是"配置"，而是"动作 → 执行者"。任何 bug 现象都是某段代码在某个时刻做了某件事的结果——找到那段代码、那个时刻、那件事，才叫定位到根因。被动定义文件（配置、schema、skill 文档）只有在某个运行时代码读它并据此动作时才会参与 bug；要修的是"读它并据此动作"的那段代码，或者它读到的数据。从症状名直接跳到同名文件，是把"名字巧合"当成了"因果关系"。
- 关联：`docs/bugReport/B003-feat-lifecycle-double-entry.md`, `multi-agent-skills/debugging/SKILL.md`（Phase 1-4 诊断协议）, `multi-agent-skills/tdd/SKILL.md`（Bug fix 必须先写失败测试）
