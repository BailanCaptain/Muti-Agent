# B022 — Prompt 注入四源冗余 + L0_DIGEST 静默 drift 风险

**Status**: Open → Fixing
**Reported**: 2026-04-27
**Author**: 黄仁勋（Claude）
**触发**: 小孙 review prompt 注入策略时质疑「CLAUDE.md / AGENTS.md / GEMINI.md / agent-prompts L0_DIGEST / shared-rules.md 是不是太冗余了」

---

## 现象

multi-agent runtime 调起 agent 走 `claude --append-system-prompt <agent-prompts 拼装>`（详见 `packages/api/src/runtime/claude-runtime.ts:70`）。`--append-system-prompt` 是**追加**而非**替换** —— Claude Code harness 默认 system prompt 会自动注入 `CLAUDE.md`。

→ 同一次 invocation 中**至少**收到 4 份重叠规则：

| 层 | 文件 | 加载机制 |
|---|---|---|
| 1 | `CLAUDE.md` (22 行) | harness 自动注入（path A + path B 都生效） |
| 2 | `AGENTS.md` (25 行) / `GEMINI.md` (24 行) | Codex / Gemini CLI harness 自动注入 |
| 3 | `agent-prompts.ts` 内 `L0_DIGEST` 常量 (29 行硬编码) | multi-agent runtime fallback —— 实际从未触发 |
| 4 | `multi-agent-skills/refs/shared-rules.md` (119 行) | runtime 文件加载（60s file cache） |

**重叠内容**：Iron Laws 4 条 / 团队介绍 / Skill 路由 / 工作流 / @ 规则 / 回答纪律 全在多处出现。

---

## 根因（git history 还原）

| commit | 日期 | 当时的 L0_DIGEST 角色 |
|---|---|---|
| `b1158af` | 2026-04-05 | feat(identity) — 引入 shared-rules.md，但当时还**只是文档**，L0_DIGEST 是注入唯一源 |
| `72d070e` | 2026-04-05 | "L0 摘要新增「诚实原则」" — 改的是 L0_DIGEST 本身，确认它当时是主真相源 |
| `56622c2` | 2026-04-06 | feat(runtime) shared-rules **runtime loading + 60s cache** — shared-rules.md 升级成运行时真相源，**L0_DIGEST 退化为 fallback** |
| `961abfd` | 2026-04-23 | R-198 shared-rules **Fail-closed** + hot-reload — 改的是 shared-rules 内容（加 P5 证据契约），fallback 路径未触动 |

**演化结论**：L0_DIGEST 是历史包袱 —— 早期没有 runtime loading 时是必要的，04-06 之后 60s file cache 上线，读文件 IO 已不是问题，L0_DIGEST 已成 dead code。

---

## 危害

1. **违反 P4「每个概念只在一处定义」** —— 同一进程同一调用注入 2 份 Iron Laws、2 份团队介绍、2 份 Skill 路由
2. **drift 风险** —— `agent-prompts.ts:18` 注释明文："修改 shared-rules.md 后记得同步更新此常量"。这条手工同步约定**已经不可能执行到位**（shared-rules.md 频繁改动，L0_DIGEST 鲜少同步）
3. **fail-open 与项目方向不一致** —— R-198 把 shared-rules 改成 Fail-closed 证据契约，但这里 fallback 是 fail-open（找不到就静默用过期版本）。最坏情况：部署到 exe 打包后路径错位，所有 agent 静默跑过期家规几天才发现

---

## 修复方案（[A] 分歧点拍板：三家齐改）

### 1. 砍 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 到最小集
保留：
- 身份段（你是 X）
- 团队介绍
- **Iron Laws 4 条**（path A 最后防线，重叠 4 行成本可接受）
- 双指针（→ shared-rules.md / agent-prompts.ts）

砍掉：Skill 路由 / 工作流链 / 回答纪律 / @ 规则段（全部已在 shared-rules.md）

### 2. 删 `L0_DIGEST` + `loadSharedRules` 改 fail-closed
- 删除 `agent-prompts.ts` 中 `L0_DIGEST` 常量（29 行）
- `loadSharedRules()` 失败时 **抛错**（不再返回空字符串）
- `buildBasePrompt()` 直接使用 `loadSharedRules()` 结果（去掉 fallback 三元）
- 加回归测试：mock fs 失败 → 访问 `AGENT_SYSTEM_PROMPTS.claude` 应抛错

---

## 修复后契约

| 层 | 内容 | 与 shared-rules.md 重叠 |
|---|---|---|
| 1/2 | CLAUDE.md / AGENTS.md / GEMINI.md（约 14 行） | 仅 Iron Laws 4 条（fail-safe 设计意图，非 drift 源） |
| 3 | ~~L0_DIGEST~~ — 已删除 | 不存在 |
| 4 | shared-rules.md（运行时真相源） | 自身即真相 |

**单一真相源契约**：
- 家规变更 → **只改** `multi-agent-skills/refs/shared-rules.md`
- 三个身份 .md 文件**永不**包含 Iron Laws 之外的规则内容
- shared-rules.md 找不到 → fail-closed 报错（拒启动），不静默 fallback

---

## 验证方式

1. `pnpm --filter @multi-agent/api test agent-prompts.test.ts` 全绿（含新加的 fail-closed 抛错测试）
2. 主仓 :8787 + worktree preview :8800 重启后，user prompt 中**不**再有 L0_DIGEST 摘要段（只有 shared-rules.md 全文）
3. 临时 mv shared-rules.md 模拟"找不到" → 进程启动时 / 首次 build prompt 时立即抛错（不是静默继续）

---

## Lessons

- 「fallback 兜底」在 fail-closed 项目里是反模式 —— 兜底等于静默偏移，违反"可验证才算完成"
- 同一概念多处冗余，**一定**会 drift。手工同步注释（"修改 X 后记得同步 Y"）是 anti-pattern
- prompt 注入路径（harness vs runtime append）需要在 onboarding 文档里讲清楚，否则 reviewer 会把"必要冗余"误判成"真冗余"或反之
