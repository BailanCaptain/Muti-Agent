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
  - **B002→B006→B010→B011 症状族**：Gemini "停了/卡了"改了四轮（classifier → stderr fast-fail → liveness probe → stall 判定），每轮解决上轮问题、引入新问题。第四轮（B011）才发现根因是组件间假设耦合（stderr 不算 activity + CPU 平算 idle + Windows 启用 stall 快杀），见 LL-008
- 原理（可选）：每个抽象层都有一个"表达力上限"——超出就靠下层表达力硬撑。反复在同一层修同类问题，等于在该层的表达力上限处打补丁。打补丁的次数是根因距离的度量：第 3 次打补丁意味着至少要上抛 1 层。
- 关联：`docs/features/F003-a2a-convergence.md`, `docs/bugReport/B001-B004`（A2A 症状族）, `docs/bugReport/B010-B011`（Gemini 停了症状族）, `multi-agent-skills/self-evolution/SKILL.md`

### LL-005: 清状态前必须审查"兜底"是否真的能兜
- 状态：validated
- 更新时间：2026-04-11

- 坑：B002 修 Gemini 429 时把错误重分类到 `context_exhausted`，新增一条清 `nativeSessionId` 路径。commit message 自信地说"handoff 通路和 clowder-ai 逐字对照后确认同构 —— 清 session 后 wrapPromptWithInstructions 会把 context-assembler 注入的'## 本房间摘要'传给新 CLI 进程"。但漏审 rolling summary 的两个死穴：(1) 要 >10 条 user 消息才生成，冷启动空窗；(2) 是压缩文本不含真实消息细节。结果 B002 的代码自洽、测试全绿，但把"清 session"的实际代价放大了 —— direct-turn 路径下 rolling summary 是**唯一**记忆通道，兜底不住。小孙随后报"超级超级超级大 bug：黄仁勋跟失忆了一样"，追因到 F004 发现是架构级失误（ca87c9d refactor 把 direct-turn 的真实历史注入路径删了，B002 在已经脆弱的地基上又加了一道清 session 闸门）。
- 根因：代码里存在 `if (fallback) use(fallback)` 不代表 fallback 在真实使用时段能兜住。把"代码存在 fallback 分支"和"fallback 实际可用"混为一谈。
- 触发条件：
  1. commit / PR 里出现任何"清 X / 重置 Y / 回退到 Z"字样
  2. 清状态的理由是"fallback 会兜住"
  3. 没有在 PR description 里逐条回答"冷启动时 Z 能用吗？并发时 Z 能用吗？Z 的信息密度够吗？Z 依赖的服务可靠吗？"
- 修复：F004 AC1-4 架构级重构 —— direct-turn 从 DB 注入真实历史，rolling summary 从"唯一通道"降级为"长历史压缩层"。同时 AC4 把 unknown case 的 `shouldClearSession` 从 `true` 改回 `false`（"不知道怎么办时保留现状比清空安全"）。
- 防护：
  1. **清状态四问**：任何涉及清状态的 PR 必须在 description 里回答 (a) fallback 在冷启动窗口能用吗？(b) fallback 的信息密度能支撑业务吗？(c) fallback 依赖的服务/资源可靠吗？(d) 没有 fallback 时用户体验是什么？— 答不出来 = 不能合入。
  2. Reviewer checklist 新增一条"清状态兜底审查"，和已有的"测试覆盖"同等权重。
  3. `failure-classifier` 等"安全网"代码改动必须配套集成测试，验证清状态后的下一轮对话在 direct-turn / A2A / 冷启动三种场景都能跑通。
- 来源锚点：
  - commit `ca87c9d refactor(context) unified Context Policy` — 真正把 direct-turn 变成"只赌 --resume + rolling summary"的 refactor
  - commit `74d64e0 fix(B002) context_exhausted 清 session` — 在已经脆弱的基础上加闸门
  - `docs/features/F004-context-memory-authoritative.md#根因（架构级）`
  - `docs/bugReport/B005-direct-turn-amnesia.md`
- 原理（可选）：分布式/异步系统中"fallback"的有效性是一个乘法：实际可用性 = (代码存在) × (数据充分) × (服务可靠) × (时机正确)。任一项趋近于 0，整个 fallback 就失效。只看代码存在而忽略其它三项 = 把乘法当加法。
- 关联：`docs/features/F004-context-memory-authoritative.md`, `docs/bugReport/B002-gemini-429-handoff.md`, `docs/bugReport/B005-direct-turn-amnesia.md`, `docs/bugReport/B006-gemini-startup-429.md`

### LL-006: 我们的"优化"和外部工具的"自恢复"在抢同一个语义时，删掉我们的
- 状态：validated
- 更新时间：2026-04-11

- 坑：B002 加 Gemini fast-fail 本意是"看到 stderr 里的 RESOURCE_EXHAUSTED 立刻砍进程，省用户 4 分钟 retry 等待"，基于"RESOURCE_EXHAUSTED 不可恢复"的假设。F004 实施期小孙手动验证 v1 (threshold=1) 立刻 @ 桂芬就崩；黄仁勋在**同一层**改成 v2 (threshold=2)，小孙再验证 **2 次 @ 仍然都崩**。直到 Codex 被请来独立在 PowerShell 裸跑 `gemini -p "只回复 OK" --model gemini-3.1-pro-preview` 6 次 → 6/6 最终成功，其中**第 4 次连续 2 次 Attempt failed with status 429 之后仍然恢复返回 OK** —— 决定性反例。真相：Gemini CLI 内置 `retryWithBackoff` 循环（10 次 × 5-30s ≈ 4 分钟）可以跨越 2+ 次连续 429 自行恢复；我们的 fast-fail 和 CLI 的 retry 在抢同一个语义，任何有限 threshold 都会把本可恢复的请求提前砍掉。v3 修复 = 删除 fast-fail 这条启发式本身。
- 根因：把"外部工具的慢"当成了"外部工具的坏"。Gemini CLI 的 retry 循环不是 bug 是 feature —— Google 官方设计成这样就是因为 transient 429 会自恢复。我们"帮用户省时间"的优化实际是在和 CLI 的正常恢复流程对抗。**当两个系统对同一信号有相反动作（CLI: retry / 我们: kill），我们这边一定是错的那个**，除非有决定性证据证明 CLI 的行为本身是 bug。LL-004 说过"同类症状同层反复打补丁 → 根因在上一层"；LL-006 是 LL-004 的一个具体展开：**上一层不一定是"更底层的代码"，也可能是"我们根本不该存在于这一层"**。
- 触发条件：
  1. 我们写的代码正在**拦截/截断/加速**某个外部工具的内建流程（retry / backoff / heartbeat / auth refresh 等）
  2. 症状报告里出现"工具的正常行为被我们砍掉了"的描述（例如"CLI 自己能 retry 的 / tool 自己能 recover 的"）
  3. 我们的拦截逻辑里有"N 次/N 秒/N 字节"这种 magic number —— 通常意味着在猜测外部工具的行为边界
- 修复：删除 `GEMINI_FAST_FAIL_PATTERNS` + `classifyStderrChunk` 覆写 + `getFastFailMatchThreshold` 虚方法整条逻辑；由 `ProcessLivenessProbe` 的 stall window 兜底真正卡死（B002 原始症状）的场景。framework 层（`classifyStderrChunk` 的虚方法本身）保留，供未来真正需要的 runtime 按需启用。
- 防护：
  1. **"同语义双动作"审查**：任何截断/加速/拦截外部工具的代码，PR description 必须回答 (a) 外部工具对这个信号的内建处理是什么？(b) 为什么我们认为它的处理不够好？(c) 有没有独立实测证据证明外部工具的内建处理确实不够好？— 答不出 = 不能合入
  2. **外部工具裸跑实测**：任何 fast-fail / early-abort 类的启发式，立项前必须有独立实测证据（最简单：在非 Multi-Agent 环境裸跑工具收集 ≥10 次样本观察实际恢复率）。不能只靠读 stderr / 读代码推演
  3. **同层补丁计数器**：同一段 fast-fail / 拦截逻辑被修 ≥2 次还不对 → 强制考虑"这段逻辑是不是根本不该存在"，而不是继续调参。LL-004 的"上抛一层"在这里的具体形态是"删除这一层"
  4. Commit message 规范：涉及外部工具行为的修改，必须写清"外部工具的内建行为 = X，我们选择 = Y，选择理由 = Z"，方便后续 grep 反省
- 来源锚点：
  - `packages/api/src/runtime/gemini-runtime.ts` (F004 AC5 v3: 删除整段 fast-fail 覆写)
  - `packages/api/src/runtime/base-runtime.ts:284-307` (framework 保留的 fast-fail 入口)
  - `docs/bugReport/B006-gemini-startup-429.md#根因分析` (三版演进)
  - `docs/features/F004-context-memory-authoritative.md#AC5` (v1→v2→v3 决策轨迹)
  - Codex 2026-04-11 手动实测 6/6 日志（决定性反例）
- 原理（可选）：外部工具（CLI / SDK / daemon）的内建行为是**时间浸泡过的设计决策**——即使某些看起来不合理（"为什么要等 4 分钟"），也往往背后有我们不知道的权衡（transient rate / 多租户 fairness / 服务端负载均衡）。在没有决定性证据之前，假设外部工具是对的，我们是错的；这比假设自己永远是对的优化带来的事故要少得多。LL-004 讲的是"垂直"上抛（上一层代码），LL-006 讲的是"横向"删除（我们不该参与这个决策）。
- 关联：`docs/features/F004-context-memory-authoritative.md`, `docs/bugReport/B002-gemini-429-handoff.md`, `docs/bugReport/B006-gemini-startup-429.md`, `docs/bugReport/B011-stall-kill-mid-retry.md`, `docs/lessons/lessons-learned.md#LL-004`, `docs/lessons/lessons-learned.md#LL-008`

---

### LL-007: 用 CLI 订阅的项目不要写 REST API Key 路径
- 状态：validated
- 更新时间：2026-04-13

- 坑：`memory-service.ts` 的 `callGeminiSummarizer` 用 `GEMINI_API_KEY` 走 REST API 调 Gemini，但项目全程用 OAuth 订阅（`oauth-personal`），`.env` 里根本没有 API Key，导致摘要器永远在 `!apiKey` 处 fallback，50 行代码从未执行过一次。
- 根因：写代码时没对照实际认证方式。REST API Key 路径和 CLI OAuth 路径是互斥的两套认证，混用等于写死代码。
- 触发条件：项目用 CLI（`claude` / `gemini` / `codex`）走订阅登录，同时代码里又有"需要 API Key"的 `process.env.XXX_API_KEY` 分支。
- 修复：删除 REST API 调用路径，改为 `spawn("gemini", ["-p", prompt])` 子进程调用，复用 CLI 的 OAuth session。
- 防护：
  1. **新写 LLM 调用前确认认证方式**：项目用 CLI 订阅 → 只能走 CLI 子进程；项目有 API Key → 才能走 SDK / REST。二者不可混写。
  2. **`process.env.*_API_KEY` 检查点**：凡是出现 `process.env.GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY`，PR review 必须问"这个 key 在 `.env.example` 里有吗？没有就是死代码"。
  3. **`.env.example` 是 API 调用的许可清单**：`.env.example` 里没有的 key，代码里不能有对应的 `process.env` 读取分支。
- 来源锚点：
  - `packages/api/src/services/memory-service.ts:127-183`（原死代码，2026-04-13 修复）
  - `C:\Users\-\Desktop\Multi-Agent\.gemini\settings.local.json`（`oauth-personal` 配置）
  - `.env.example`（无任何 `*_API_KEY` 条目）
- 关联：`docs/bugReport/B010-windows-liveness-blind-spot.md`

### LL-008: 改一个组件前，必须端到端走完信号链
- 状态：validated
- 更新时间：2026-04-13

- 坑：B010 在 liveness probe 层加了 Windows CPU 采样并启用 `canClassifySilentState()=true`，4 个 probe 单元测试全绿，commit message 自信地说"Windows 和 Unix 走相同的 CPU 分类路径"。但没有走完从 stderr 输入到进程被杀的完整链路。隔天桂芬在 429 重试的第 6 次（距最后 stdout 184 秒）被 stall 快杀误杀。追踪信号链发现：B010 启用了第 ⑥ 跳（`canClassifySilentState=true`），但第 ② 跳（`forwardStderr` 故意不更新 `lastActivityMs`）的假设在新状态下和 ⑥ 冲突——stderr 活跃 + CPU 平 + stall 快杀启用 = 误杀。两个假设各自合理，但**从未被组合验证**。
- 根因：每个组件有自己的隐含假设（probe: "CPU 平=卡死"；activity timer: "stderr=噪声"）。这些假设在组件独立测试时各自成立，但组合后可能冲突。改一个组件的行为（B010 启用 stall 快杀）等于改变了其他组件假设的前提条件，但修改者只验证了自己那一层。
- 触发条件：
  1. 改动启用/禁用了一条控制路径（if 条件从 false 变 true 或反之）
  2. 这条路径依赖其他组件的输出/状态（例如 stall 判定依赖 activity timer + probe state）
  3. 改动只测了自己改的组件，没有端到端集成测试
- 修复：`base-runtime.ts` 新增 `lastStderrMs`，stall 判定用 `Math.max(lastActivityMs, lastStderrMs)`。新增端到端集成测试覆盖"stdout 沉默 + stderr 活跃 → 不被杀"场景。
- 防护：
  1. **信号链走查**：任何涉及"启用/禁用控制路径"的改动，PR description 必须画出从输入信号到最终动作的完整链路（每一跳列出：输入 → 判定 → 输出），并标注每一跳的假设。不完整 = 不能合入。
  2. **假设兼容性检查**：信号链上有 N 个跳，就有 N 个假设。改了其中一个跳的行为后，必须回答"其他 N-1 个假设在新行为下还成立吗？"
  3. **端到端集成测试**：涉及进程生命周期（spawn / kill / timeout）的改动，必须有至少一个集成测试覆盖"从外部信号输入到进程最终状态"的完整路径。单元测试不够——B010 的 4 个 probe 单元测试全绿但没能发现组合问题。
  4. **实测验证**：涉及外部 CLI 行为的改动，必须在真实环境跑一遍（不是 mock）。B010 没有在 Windows 上实际跑一遍"Gemini 遇 429 重试 → 观察是否被误杀"。
- 来源锚点：
  - `packages/api/src/runtime/base-runtime.ts:264-266,305-308,479-495`（信号链的三个关键跳）
  - `docs/bugReport/B011-stall-kill-mid-retry.md`（完整信号链追踪）
  - `docs/bugReport/B010-windows-liveness-blind-spot.md`（引入回归的改动）
  - `packages/api/src/runtime/base-runtime.test.ts`（B011 新增的端到端测试）
- 原理（可选）：多组件系统的 bug 往往不在单个组件内部，而在组件间的**假设耦合**处。每个组件维护者都觉得"我这层的假设合理"，但没人负责验证假设的组合。单元测试验证的是"组件内部逻辑对不对"，不是"组件间假设兼不兼容"——后者只有端到端测试或信号链走查才能覆盖。LL-004 讲的是"同一症状修多次 → 上抬一层"，LL-008 讲的是"改一个组件 → 横扫所有耦合假设"。一个是纵向（层级），一个是横向（组件间）。
- 关联：`docs/bugReport/B010-windows-liveness-blind-spot.md`, `docs/bugReport/B011-stall-kill-mid-retry.md`, `docs/lessons/lessons-learned.md#LL-004`, `docs/lessons/lessons-learned.md#LL-006`

### LL-009: 同一隔离缺陷修了一条路径，漏了并行路径
- 状态：validated
- 更新时间：2026-04-13

- 坑：`05618ac` 修"Decision Board 收敛泄漏"时，在 `DecisionStore`（inline decision cards）的渲染处（`timeline-panel.tsx:82`）加了 `sessionGroupId === activeGroupId` 过滤。但 F002 后来引入的 `DecisionBoardStore`（board flush 整体弹窗）走的是另一条渲染路径（`decision-board-modal.tsx:71`），从未加过 session 校验。结果串行讨论的 board 卡片仍然跨房间泄漏——修了 Store A 漏了 Store B。
- 根因：修 bug 时只追踪了**当前症状的调用链**（`DecisionStore → timeline-panel`），没有 grep "同一概念的所有消费者"。`DecisionStore` 和 `DecisionBoardStore` 是同一个领域概念（decision）的两个并行实现，共享同一类隔离需求，但修复者只知道其中一个。
- 触发条件：
  1. 同一领域概念有 2+ 个 store / 组件 / 路径（例如 `decision-store` vs `decision-board-store`）
  2. 修隔离/过滤/权限类 bug 时只改了其中一个路径
  3. Grep `sessionGroupId` 或领域关键词时会命中多个 store / 组件
- 修复：`decision-board-modal.tsx` 添加 `useThreadStore` → `activeGroupId`，early return 条件加 `sessionGroupId !== activeGroupId`。
- 防护：
  1. **同概念全路径扫描**：修隔离/过滤/安全类 bug 时，先 grep 领域关键词（例如 `decision`、`sessionGroupId`），列出**所有**消费该概念的 store / 组件，逐一确认是否存在同类缺陷。
  2. **PR checklist 新增"并行路径"项**：凡涉及 session 隔离的修复，必须列出"该概念的所有 store / 渲染路径"并标注哪些已修、哪些不受影响。
  3. **命名约定**：同领域的多个 store 名字应有共同前缀（`decision-store` / `decision-board-store` 可以发现），修一个时 grep 前缀。
- 来源锚点：
  - `components/chat/decision-board-modal.tsx:71`（漏修的路径）
  - `components/chat/timeline-panel.tsx:82`（已修的路径）
  - `components/stores/decision-board-store.ts`（F002 引入的并行 store）
  - commit `05618ac`（只修了一条路径的原始修复）
- 原理（可选）：隔离缺陷是**概念级**的，不是**组件级**的。修一个组件等于修了一条路径，但同一概念可能流经 N 条路径。"修完 grep 一下"的成本 ≤ 5 分钟，"漏了等用户报 bug"的成本 ≥ 1 天。
- 关联：`docs/bugReport/B007-decision-board-convergence-leak.md`, `docs/features/F002-decision-board.md`

### LL-010: 前端不要用正则从非结构化文本猜结构——结构化应在数据源头完成
- 状态：validated
- 更新时间：2026-04-14

- 坑：F006 的 StepTracker 用正则从 agent stdout 文本中提取工具调用（`/^(✅|⏳)\s+(\w+)\s*(\{.*\})?/`），被德彪 review 打回 4 轮——误删正文 ↔ 漏匹配工具调用交替出现，每修一个 case 就破另一个 case。根本原因：agent CLI 输出是非结构化文本，同一行既可能是工具调用也可能是正文，正则无法可靠区分。
- 根因：把"展示层解析"当成了架构问题的解法。agent 输出本来就有结构化信息（NDJSON 事件流），但我们跳过了后端结构化这一步，直接在前端用正则猜。这等于用 O(N) 的 patch 去修一个 O(1) 的架构缺失。
- 触发条件：
  1. 数据源有结构化格式但系统没有消费它
  2. 展示层用字符串匹配 / 正则从非结构化文本中"猜"结构
  3. 补丁数 > 3 且每个补丁修一个 case 破另一个 case
- 修复：实现 Event Transformer 架构——后端 `transformToolEvent()` 在 NDJSON 层提取结构化 `ToolEvent`，前端 `StepTracker` 只消费 `ToolEvent[]`，零正则。三个 runtime（Claude/Codex/Gemini）各自实现事件格式到统一类型的映射。
- 防护：
  1. **"补丁数 > 3 就停"规则**（家规 P3）：正则补丁来回打补丁 > 3 次时，强制停下来审视是不是在错误的层解决问题。
  2. **数据流审计**：在展示层做解析前，先问"数据源有没有已有的结构化格式？"如果有（NDJSON、protobuf、typed events），在数据源头提取，不要到前端再猜。
  3. **参照物验证**：clowder-ai 在后端就把 NDJSON 分好类（`transformEvent()`），前端只消费结构化数据。我们参照后确认了方向正确性。
- 来源锚点：
  - `packages/api/src/runtime/base-runtime.ts`（`transformToolEvent()` 虚方法）
  - `packages/api/src/runtime/claude-runtime.ts`、`codex-runtime.ts`、`gemini-runtime.ts`（三个实现）
  - `components/chat/rich-blocks/step-tracker.tsx`（重写后零正则的消费端）
  - commit `04a0764`（Event Transformer 完整架构）
- 原理（可选）：信息论视角——结构化信息在传递过程中只能丢失不能增加。NDJSON 事件流中"这是 tool_use 还是 text"是确定性信息，丢弃后在 stdout 文本里用正则恢复是有损还原，准确率永远 < 100%。正确做法是在信息最丰富的层（数据源头）提取并传递结构化字段。
- 关联：`docs/features/F006-ui-ux-refinement-and-runtime-governance-v2.md`

### LL-011: WebSocket 事件广播必须从第一天就有会话级过滤（Room 概念）
- 状态：validated
- 更新时间：2026-04-14

- 坑：WebSocket `broadcast()` 向所有连接的 socket 全量广播事件，没有 Room / Channel 概念。13 种事件类型中只有 `message.created` 做了 `sessionGroupId` 过滤（因为它最早写，当时顺手加了），其他 12 种全是盲发。结果：用户在 A 会话时，B 会话的 `assistant_delta` / `thread_snapshot` / `status` 直接推过来——轻则状态闪烁，重则 `thread_snapshot` 覆盖当前会话的 timeline 状态。
- 根因：最早实现 WebSocket 时只有一个会话，"全量广播"没有问题。多会话上线后没人回头给 broadcast 加隔离，成了温水煮青蛙——每个新事件类型的开发者都复制了 `broadcast` 模式，没有质疑"这个事件需要所有 socket 都收到吗？"
- 触发条件：
  1. 多会话并发（用户在 A 聊天，B 有 agent 在跑）
  2. 新增 WebSocket 事件类型时复制了已有的 `broadcast` 调用模式
  3. 前端 handler 不检查事件归属就直接更新状态
- 修复：三层闭环——① 共享类型给所有会话级事件加 `sessionGroupId` 字段 ② 服务端所有 emit 点带上 `thread.sessionGroupId` ③ 前端每个 handler 用 `isCurrentSession()` 过滤。覆盖全部 13 种事件类型 + `status` 事件 18 个发射点。
- 防护：
  1. **新事件类型必须声明隔离级别**：在 `realtime.ts` 添加新事件类型时，必须回答"这个事件是全局的还是会话级的？"会话级必须带 `sessionGroupId`。
  2. **前端 handler 必须有过滤**：`page.tsx` WebSocket handler 中，每个新事件的 handler 必须包含 `isCurrentSession()` 检查（或注释说明为什么是全局事件不需要过滤）。
  3. **LL-009 的"同概念全路径扫描"同样适用**：新增隔离相关修改时，grep `broadcast` 和 `emit` 确认所有发射点都已覆盖。
- 来源锚点：
  - `packages/shared/src/realtime.ts`（7 种事件 payload 加 `sessionGroupId`）
  - `packages/api/src/services/message-service.ts`（`emitThreadSnapshot` + `assistant_delta` + `assistant_tool_event` 等发射点）
  - `app/page.tsx`（前端 `isCurrentSession()` 过滤）
  - commit `524322c`（会话隔离初始修复）、`27ca113`（status 事件补全）
- 原理（可选）：多租户系统的隔离不是"后面加"的特性，而是"第一天就必须有"的基础设施。每推迟一天，新代码就多复制一次无隔离的模式。修复成本 = 事件类型数 × 发射点数 × 消费点数，随系统演进呈 O(N²) 增长。
- 关联：`docs/lessons/lessons-learned.md#LL-009`, `docs/features/F006-ui-ux-refinement-and-runtime-governance-v2.md`

### LL-012: 流式数据的中间状态必须有持久化策略，不能只靠最终落盘
- 状态：validated
- 更新时间：2026-04-14

- 坑：`assistant_delta` 事件只推 WebSocket，从不写 DB。assistant 消息初始 content 为空字符串。`toolEvents` 也只在 `overwriteMessage`（run 完成后）才落盘。用户在流式输出期间切走再切回——前端 store 被替换，`selectSessionGroup` 从 DB 读 → 拿到空字符串 → 消息框空白、步进器消失。
- 根因：把"最终一致性"当成了实时系统的持久化策略。流式系统有两类消费者：① 实时 socket 连接 ② 后来恢复的连接。只服务第一类等于假设"用户永远在线"。
- 触发条件：
  1. 数据只通过 WebSocket 推送，中间不落盘
  2. 用户可以断连 / 切换视图 / 刷新页面
  3. 恢复时从 DB 读取的是初始空值而非最新累积值
- 修复：实现 `streamingFlushers` 机制——注册 flusher 捕获 content/thinking/toolEvents 的闭包引用。两条消费路径主动 flush：① `emitThreadSnapshot()` 前调用 `flushActiveStreaming()` ② `GET /api/session-groups/:groupId` 前调用 `flushActiveStreaming()`。用户切会话时 API 先 flush 再读 DB，保证数据完整。
- 防护：
  1. **新增流式数据字段时必须回答"断连恢复怎么办"**：如果答案是"等 run 完才写 DB"，必须在 flusher 中注册该字段。
  2. **flusher 生命周期管理**：success path 和 error path 都要清理（`streamingFlushers.delete()`），避免孤儿 flusher 内存泄漏。
  3. **测试覆盖**：流式数据的"写入-断连-恢复-读取"路径需要集成测试覆盖。
- 来源锚点：
  - `packages/api/src/services/message-service.ts`（`streamingFlushers` Map + `flushActiveStreaming()`）
  - `packages/api/src/routes/threads.ts`（`GET /api/session-groups/:groupId` 前 flush）
  - commit `a90edfd`（初始 3s flush）、`e4e3573`（切会话即时 flush + 生命周期管理）
- 原理（可选）：流式系统 = 实时推送 + 断连恢复。只做推送不做恢复 = 只服务"永远在线"的用户，这在 Web 应用中是不成立的假设。持久化策略应该在数据累积开始时就设计，而不是"run 完再说"。
- 关联：`docs/features/F006-ui-ux-refinement-and-runtime-governance-v2.md`
