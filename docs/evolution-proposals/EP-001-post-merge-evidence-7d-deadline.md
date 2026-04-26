# EP-001: AC 标 "post-merge 验证" 必须在 7d 内补具体证物，否则视为虚标

> 状态：accepted (Option B — 仅 quality-gate skill)
> 提案人：黄仁勋（Claude）
> 日期：2026-04-25
> 拍板：小孙 2026-04-25 选 B 方案（最小杠杆 + 不动 shared-rules）

---

## 1. Trigger（触发）

B019（2026-04-25 立项）发现 F018 模块六本地 embedding 在 production 永久不可用 ——
`message_embeddings` 表 0 行（F018 完工 1 周、1856 messages、0 写入）。
F018 P5 当时声称 AC9.1（跨 agent 验证 `recall_similar_context` 真实使用能找到历史）+
AC9.2（embedding 落库一周抽查）"post-merge 跨 agent / 手工验证"，但
`git log --grep` + Timeline 全仓 grep 找不到任何 `SELECT COUNT(*)` 或真实 recall 调用证物。

**关键事实**：F018 立项动机本身就是修 F007 模块五 AC5.2/5.5 虚标
（"代码全在生产调用 0"），结果 F018 自己又虚标——**修空壳的 feature 自己空壳**。

## 2. Evidence（证据，至少 2 个来源）

| # | 来源 | 证据 |
|---|------|------|
| 1 | F007 模块五（2026-04-14 完成）→ F018 立项依据 | AC5.2 `CREATE TABLE message_embeddings` 没进 `db/sqlite.ts` → 虚标 ✅；AC5.5 "context-assembler 构建历史时额外做语义检索" 实际代码零引用 → 虚标 ✅；详见 `docs/features/F018-context-resume-rebuild.md:32-35` |
| 2 | F018 模块六（2026-04-18 完成）→ B019 立项依据 | AC9.1/9.2 标 "post-merge 跨 agent / 手工验证"，但 P5 merge 后 7 天无任何 SELECT/curl 证物，全仓 grep 0 命中；Codex review 14 轮全过 + 738/738 tests 绿 + acceptance-guardian 通过，但**全员默认 hook 接进来就工作**，没人去查表；详见 `docs/bugReport/B019-f018-embedding-huggingface-offline.md` |

## 3. Root Cause（根因）

不是个人疏漏，是**流程缺口**：

1. **AC checkbox 视为真相源**：spec checkbox `[x]` 跟"实际证物"在自检/验收/review 三道门里都没绑定。`quality-gate` 说"spec checkbox 不是真相源"但只针对 commit/PR 状态，没覆盖"代码 wiring 过 ≠ 功能生效"
2. **"post-merge 验证"是逃生口**：把验收难做的项标成 post-merge，merge 后没人回头补，自然变成虚标。无明确补齐时限 = 永远不补
3. **测试通过 ≠ 端到端可观测**：F018 P5 738 tests 绿但 production 调用 0。所有测试都用 DI mock pipelineLoader，没有任何测试**真的去查 message_embeddings 表行数**或**真的发条消息看 recall hits**。这是 LL-022（测试金字塔倒置）的另一种表达，但 LL-022 只覆盖"UI 呈现"，没覆盖"backend wiring vs production 生效"
4. **"修空壳"feature 的对镜检查缺失**：F018 立项动机写在 `Why` 里——"F007 模块五 Step 7/8 未接入 → 虚标 ✅"，结果立项时没把这个动机变成 F018 自己的硬验收门（"merge 后 7 天必须真去查表"）

## 4. Lever（最小杠杆改动）

**最终采纳：Option B — 只改 quality-gate skill 一处，shared-rules 不动。**

小孙 2026-04-25 决策依据：
- shared-rules 是"运行时安全 / 协作纪律"级硬规则池；"7 天补齐 / 外部观测"是程序员守则级，进 shared-rules 会稀释硬规则池密度（家规 P4「每个概念只在一处定义」）
- shared-rules 全文每次注入 system prompt（实测 ~3642 token/次 + 当前无 prompt cache），加 +550 token × 75 invocations/天 = +41k token/天的 baseline 增量；quality-gate skill 只在自检触发时加载（~1.5k token/天）
- F018 走完 quality-gate + acceptance-guardian + 14 轮 review 没拦住 → 根因不是规则不在 review/acceptance 里，是规则**根本不存在**。Step 0.6 加到自检关卡当时就能拦住

延期项（暂不做，30/60d replay 时复评）：
- shared-rules 加 §「证据完整性」rule 18+19（如果发现 acceptance-guardian / merge-gate 也需要外部观测硬规则，再升）

---

**已落地（Option B）**：

  **`multi-agent-skills/quality-gate/SKILL.md`** Step 0.5 后加 Step 0.6「EXTERNAL OBSERVABILITY CHECK」（已 commit）

---

**原 Option A 草案（保留作为延期参考）**：

  **(a) `multi-agent-skills/refs/shared-rules.md`** 加一节 §「Post-merge 证物补齐」：
  ```
  AC 标 "post-merge 验证" / "上线后手工项" 的项必须在 merged 后 7 个自然日内补齐
  到 feature doc Timeline，证物形如：
    - SQL: SELECT COUNT(*) FROM <table> = N
    - curl: <endpoint> 返回 <字段值>
    - 命令: <command> 输出 <关键行>
  仅"测试 pass" / "代码 review 过" 不算证物。
  超期未补 → feature 被自动重新打开（reopen）+ Owner 在 standup 解释，否则视为虚标。

  涉及"外部可观测状态"的 feature（DB 写入 / 文件落地 / runtime log warn 计数 /
  消息发送 / 队列入队等）— 即使所有 AC 都打勾、所有测试都绿，merged 时仍要附
  一行外部观测证物（行数 / 字节数 / 计数），不能只是"代码 wiring + tests pass"。
  ```

  **(b) `multi-agent-skills/quality-gate/SKILL.md`** Step 0 后加一段「外部可观测证物」：
  ```
  Step 0.6: EXTERNAL OBSERVABILITY CHECK（涉及 DB / 文件 / log / 队列时）

  问自己：这个 feature 完成后，外部最直接能看到什么变化？
    - DB 写入：跑 SELECT COUNT(*) 看行数
    - 文件落地：ls -la 看大小 / find 看路径
    - log 计数：grep -c 看错误数变化
    - 队列：peek 看消息

  如果想不出"外部最直接能看到什么"，说明 feature 没真正交付——回去补 AC。
  如果"外部观测"在 wiring 改造后没真跑过，自检就视为未完成。
  ```

- **为什么这是最小杠杆**：
  - 不动 SystemPrompt / agent-prompts.ts（更高杠杆但风险大、波及全 agent）
  - 不动 L0 (CLAUDE.md)（最高杠杆，留给跨项目共识）
  - 改 memory（单条 feedback）作用域单 agent，但本规则是流程级跨 agent 适用 → 不够
  - shared-rules + quality-gate skill 是流程级真相源，加规则不删旧规则，向后兼容

## 5. Verify（验证方式）

- **短期**（接下来 30 天）：B019 自身（修 F018 二阶虚标的 feature）必须按本规则交付——
  merge B019 时 Timeline 必须含一行 `SELECT COUNT(*) FROM message_embeddings = N`
  + log warn 计数 + recall hits 数；7d 后 replay 查 production 库再补一行。
  本 feature 是规则的第一个 dogfood case。
- **长期**（30/60/90 天）：
  - 30d replay：grep 全仓 `git log --grep="post-merge"` 看是否每条都有 7d 内补齐 commit
  - 60d 复盘：查近期 merged feature 是否还有"AC 全 ✅ but 0 行表/0 文件/0 log"的虚标
  - 90d 衰减检查：本规则被引用过吗？quality-gate 报告里有出现 "Step 0.6 EXTERNAL
    OBSERVABILITY CHECK" 字眼吗？没有 = 规则没落地 = 改写得更短/更显眼

---

## 审批

- [x] 影响范围确认：**全团队**（跨 agent 流程规则，黄仁勋 / 范德彪 / 桂芬 都受 quality-gate 约束）
- [x] 小孙拍板：2026-04-25 选 B 方案（仅 quality-gate skill）
- [x] 落地 commit/PR：本 EP 与 LL-030 + B019 fix 在同一 worktree，PR 一并合入

## 关联

- **教训沉淀**：`docs/lessons/lessons-learned.md` LL-030（同 commit 写入）
- **触发 bug**：`docs/bugReport/B019-f018-embedding-huggingface-offline.md`
- **同型空壳前序**：`docs/features/F007-context-compression-optimization.md`（F007 模块五）
- **二阶受害者**：`docs/features/F018-context-resume-rebuild.md`（F018 模块六）
- **已有规则的延伸**：
  - LL-004（同层第三次打补丁上抛架构）— 本 EP 是 LL-004 在"修空壳"语境下的二阶补强
  - LL-018（源码 vs 产物）/ LL-020（汇报 vs 验证）— 本 EP 把验证链从 UI 层延伸到 backend wiring 层
  - LL-022（测试金字塔在 UI 呈现倒置）— 本 EP 把"测试 ≠ 用户可见"的命题扩到"测试 ≠ 外部可观测"
