# F019 Skill Bulletin Board Implementation Plan

**Feature:** F019 — `docs/features/F019-skill-bulletin-board.md`
**Goal:** 用 WorkflowSop 状态机 + sopStageHint 一行注入 + update-workflow-sop callback 替换 `prependSkillHint` 关键词注入层；顺带修复三挂载点 drift + 补写 BOOTSTRAP.md。对标 clowder-ai F073 P4 告示牌哲学。
**Acceptance Criteria:**
- AC1: WorkflowSopService 持久化 SQLite，stage 枚举 `kickoff | impl | quality_gate | review | merge | completion`，版本号乐观锁
- AC2: 每次 CLI invocation system prompt 包含 `sopStageHint`（thread 绑 feature 时）
- AC3: Agent 可通过 MCP tool `update_workflow_sop` 或 HTTP callback 推进 stage，两路径行为一致
- AC4: `multi-agent-skills/BOOTSTRAP.md` 存在，含压缩表 + `<EXTREMELY_IMPORTANT>` 段 + 三 CLI 加载方式说明
- AC5: `pnpm run sync-skills` 后三挂载点零 dangling link；`pnpm check` drift 时 exit 1
- AC6: `prependSkillHint` / `buildSkillHintLine` / `matchOrthogonalSkills` 删除，`message-service.ts:69-73` 历史注释同步清理
- AC7: 自动化重放 "讨论一下" 场景通过（三 agent 看到 sopStageHint → 扇入者主动加载 SKILL.md → Mode C 三件套触发）
- AC8: 愿景对照三问全 ✅，独立验收守护 agent 输出证物对照表全匹配

**Architecture:**
- **持久化层**：新 SQLite 表 `workflow_sop`（drizzle schema）+ 新 repo `workflow-sop-repository.ts` + `threads.backlog_item_id` 新列做 thread → feature 绑定
- **Service 层**：新 `WorkflowSopService`（内存缓存 + DB 持久化 + 乐观锁版本）
- **注入层**：`agent-prompts.ts` 新增 `buildSystemPromptWithHints(provider, context)` 函数（保留 `AGENT_SYSTEM_PROMPTS` 为 fallback），`cli-orchestrator.ts` 调用时传入 per-invocation `sopStageHint`
- **推进入口**：`POST /api/callbacks/update-workflow-sop` + MCP tool `update_workflow_sop` 共享同一 Service 方法
- **基建**：增强 `scripts/mount-skills.sh` 清 dangling，`scripts/check-skills.ts` drift → error；新写 `multi-agent-skills/BOOTSTRAP.md`

**Tech Stack:** TypeScript · drizzle-orm · better-sqlite3 · Fastify routes · MCP server · node:test · Biome

---

## Straight-Line Check

**Pin finish line (B)**：
- `pnpm check` 全绿，`check-skills.ts` 对 dangling symlink 返回 exit 1
- 任一 thread 绑定 feature（`threads.backlog_item_id = 'F019'`）后，对应 CLI invocation 的 system prompt 最后一行是 `SOP: F019 stage=impl → load skill: tdd`
- Agent 可通过 MCP tool 或 HTTP 推进 stage，DB 可查版本号递增
- Repo grep `prependSkillHint` / `buildSkillHintLine` 结果为 0
- `BOOTSTRAP.md` 存在、manifest 里每个 skill 都在 BOOTSTRAP 表里出现
- 自动化测试 `replay-discussion.test.ts` 通过：构造"@三人 讨论一下" → 验证扇入者的 tool_events 含 SKILL.md 读取 + 综合纪要含 Mode C 三件套段

**Terminal Schema**：

```typescript
// packages/api/src/db/schema.ts — 新增
export const workflowSop = sqliteTable("workflow_sop", {
  backlogItemId: text("backlog_item_id").primaryKey(),
  featureId: text("feature_id").notNull(),
  stage: text("stage").notNull(),  // "kickoff"|"impl"|"quality_gate"|"review"|"merge"|"completion"
  batonHolder: text("baton_holder"),
  nextSkill: text("next_skill"),
  resumeCapsule: text("resume_capsule").notNull().default("{}"),
  checks: text("checks").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
})

// threads 加一列
// threads.backlog_item_id TEXT — nullable，引用 workflow_sop.backlog_item_id

// packages/api/src/services/workflow-sop-service.ts — 新文件
export type SopStage = "kickoff" | "impl" | "quality_gate" | "review" | "merge" | "completion"
export type CheckStatus = "attested" | "verified" | "unknown"
export interface ResumeCapsule { goal: string; done: string[]; currentFocus: string }
export interface SopChecks {
  remoteMainSynced: CheckStatus
  qualityGatePassed: CheckStatus
  reviewApproved: CheckStatus
  visionGuardDone: CheckStatus
}
export interface WorkflowSop {
  backlogItemId: string; featureId: string; stage: SopStage
  batonHolder: string | null; nextSkill: string | null
  resumeCapsule: ResumeCapsule; checks: SopChecks
  version: number; updatedAt: string; updatedBy: string
}
export interface UpdateSopInput {
  backlogItemId: string; featureId?: string; stage?: SopStage
  batonHolder?: string | null; nextSkill?: string | null
  resumeCapsule?: Partial<ResumeCapsule>; checks?: Partial<SopChecks>
  expectedVersion?: number  // 乐观锁
  updatedBy: string
}
export class WorkflowSopService {
  get(backlogItemId: string): WorkflowSop | null
  upsert(input: UpdateSopInput): WorkflowSop   // 幂等 upsert + 乐观锁检查
  delete(backlogItemId: string): void
}

// packages/api/src/runtime/agent-prompts.ts — 新增函数（不动现有 AGENT_SYSTEM_PROMPTS）
export interface InvocationContext {
  sopStageHint?: { featureId: string; stage: string; suggestedSkill: string | null }
}
export function buildSystemPromptWithHints(provider: Provider, ctx: InvocationContext): string

// packages/api/src/routes/callbacks.ts — 新 endpoint
POST /api/callbacks/update-workflow-sop
body: { invocationId, callbackToken, backlogItemId, stage?, batonHolder?, nextSkill?, resumeCapsule?, checks?, expectedVersion? }
→ 调 WorkflowSopService.upsert({...input, updatedBy: 调用者 agentId})

// packages/api/src/mcp/server.ts — 新 MCP tool
tool: update_workflow_sop
schema: 同 HTTP body minus auth 字段
→ 走同一 Service 方法
```

**Not in scope（A→B 不绕路）**：
- IntentParser (`#ideate` / `#execute`) — Open Question 1 已定延后
- Redis 持久化 — 小孙拍板 SQLite
- pre-commit hook 自动 sync — 本 feat 只做 pnpm check + 手动脚本
- `sop_navigation` hard_rules/pitfalls 虽然在 Scope 里，但不阻塞 Mode B/C 断档修复，**降级到 P1 可选**

**纯探索 Spike**：无。所有步骤都是交付物。

---

## Phase 1: 基建清理（1.5~2d）

**目标**：三挂载点同步机制可靠 + BOOTSTRAP.md 就位 + manifest sop_navigation 补字段。这阶段与 P2/P3 解耦，可独立合入，不阻塞后续。

### Task 1.1: 增强 `scripts/check-skills.ts` — dangling symlink 变成 error

**Files:**
- Modify: `scripts/check-skills.ts:113-134`（symlink 检查段）

**Step 1: 写失败测试**

新文件：`scripts/check-skills.dangling.test.ts`

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

describe("check-skills.ts — dangling symlink detection", () => {
  it("reports dangling symlink as error and exits 1", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "check-skills-"))
    mkdirSync(path.join(tmp, "multi-agent-skills"))
    mkdirSync(path.join(tmp, ".claude/skills"), { recursive: true })
    writeFileSync(
      path.join(tmp, "multi-agent-skills/manifest.yaml"),
      "skills: {}\n",
    )
    // Create dangling symlink
    symlinkSync(
      path.join(tmp, "multi-agent-skills/ghost"),
      path.join(tmp, ".claude/skills/ghost"),
    )

    const repoRoot = path.resolve(__dirname, "..")
    let exitCode = 0
    try {
      execSync(`npx tsx ${repoRoot}/scripts/check-skills.ts`, {
        cwd: tmp,
        stdio: "pipe",
      })
    } catch (e: any) {
      exitCode = e.status
    }
    assert.equal(exitCode, 1)
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

**Step 2: 跑测试确认失败**

```
npx tsx --test scripts/check-skills.dangling.test.ts
```
预期：FAIL（当前 check-skills.ts 对 dangling 只 warning 不 error）

**Step 3: 最小实现 — dangling 升级为 error**

Modify `scripts/check-skills.ts:113-134`：替换整段 symlink 检查为：

```typescript
for (const cliDir of CLI_DIRS) {
  const cliLabel = path.basename(path.dirname(cliDir))
  if (!existsSync(cliDir)) {
    warnings.push({ rule: "symlink", detail: `${cliLabel}/skills/ directory does not exist` })
    continue
  }

  // 1. Every manifest skill has a symlink
  for (const name of skillNames) {
    const linkPath = path.join(cliDir, name)
    if (!existsSync(linkPath)) {
      warnings.push({ rule: "symlink-missing", detail: `${cliLabel}/skills/${name} missing (run pnpm mount-skills)` })
      continue
    }
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) {
      warnings.push({ rule: "symlink-type", detail: `${cliLabel}/skills/${name} is not a symlink` })
    }
  }

  // 2. Every entry in CLI dir has a corresponding manifest skill (dangling detection)
  for (const entry of readdirSync(cliDir, { withFileTypes: true })) {
    const linkPath = path.join(cliDir, entry.name)
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) continue
    // Dangling: symlink exists but target doesn't
    const target = readlinkSync(linkPath)
    const resolvedTarget = path.resolve(cliDir, target)
    if (!existsSync(resolvedTarget)) {
      errors.push({
        rule: "dangling-symlink",
        detail: `${cliLabel}/skills/${entry.name} → ${target} (target missing; run pnpm mount-skills --prune)`,
      })
      continue
    }
    // Orphan: symlink target exists but skill not in manifest
    if (!skillNames.includes(entry.name)) {
      errors.push({
        rule: "orphan-symlink",
        detail: `${cliLabel}/skills/${entry.name}: symlink exists but skill not in manifest`,
      })
    }
  }
}
```

**Step 4: 跑测试确认通过**

```
npx tsx --test scripts/check-skills.dangling.test.ts
```
预期：PASS

**Step 5: 跑真环境验证——当前应该报 3 个 dangling error**

```
pnpm check:skills 2>&1 | tail -20
```
预期：看到 6 个 dangling-symlink error（`.agents/` 3 个 + `.gemini/` 3 个：ask-dont-guess / hardline-review / merge-approval-gate），exit 1

**Step 6: 不在此 Task commit**——先做 Task 1.2 清理，保持 `pnpm check` 走到绿。

---

### Task 1.2: 增强 `scripts/mount-skills.sh` — 加 `--prune` 模式清 dangling

**Files:**
- Modify: `scripts/mount-skills.sh`（整个文件重构）
- Modify: `package.json:scripts`（加 `mount-skills` 与 `mount-skills:prune` 两个 npm script）

**Step 1: 手工测试先行（shell 脚本不走 node test）**

在 `/tmp` 造一个模拟目录，先运行现状 `mount-skills.sh` 确认它 **不** 清 dangling：

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/multi-agent-skills/foo" "$tmp/.claude/skills"
echo "dummy" > "$tmp/multi-agent-skills/foo/SKILL.md"
ln -s "$tmp/multi-agent-skills/ghost" "$tmp/.claude/skills/ghost"  # dangling
cd "$tmp" && bash "$OLDPWD/scripts/mount-skills.sh"
ls -la .claude/skills/
# 预期：ghost dangling 还在（现状 bug）
```

**Step 2: 实现 `--prune` 模式**

Modify `scripts/mount-skills.sh`，在 L94（脚本末尾统计前）插入：

```bash
# Prune: remove symlinks whose target no longer exists in multi-agent-skills/
pruned=0
if $FORCE || [[ "${1:-}" == "--prune" || "${2:-}" == "--prune" ]]; then
  for target_dir in "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"; do
    [ ! -d "$target_dir" ] && continue
    for link in "$target_dir"/*; do
      [ ! -L "$link" ] && continue
      name=$(basename "$link")
      if [ ! -d "$SKILLS_SRC/$name" ]; then
        rm -f "$link"
        pruned=$((pruned + 1))
      fi
    done
  done
fi

echo "Skills: $mounted mounted, $unchanged unchanged, $cleaned cleaned, $pruned pruned, $skipped skipped."
```

同时修改脚本顶部 FORCE 解析为支持多 flag：

```bash
FORCE=false
PRUNE=false
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=true
  [[ "$arg" == "--prune" ]] && PRUNE=true
done
```

下方 prune 判断改为 `if $FORCE || $PRUNE; then`。

**Step 3: 更新 `package.json`**

```json
"scripts": {
  "mount-skills": "bash scripts/mount-skills.sh",
  "mount-skills:prune": "bash scripts/mount-skills.sh --prune",
  ...
}
```

**Step 4: 真环境跑 prune，清掉 3 个 dangling**

```
pnpm mount-skills:prune
```
预期输出包含 `pruned=6`（`.agents/` 和 `.gemini/` 各 3 个：ask-dont-guess / hardline-review / merge-approval-gate）

验证：
```
ls .agents/skills/ .gemini/skills/ | sort -u | wc -l
# 预期：15（每个 CLI 15 个 skill symlink）
```

**Step 5: 再跑 `pnpm check:skills`**

```
pnpm check:skills
```
预期：`✅ PASSED: 0 errors, N warnings`（可能有少量 symlink warning 但无 dangling error）

**Step 6: Commit Task 1.1 + 1.2**

```bash
git add scripts/check-skills.ts scripts/check-skills.dangling.test.ts scripts/mount-skills.sh package.json .agents/skills/ .gemini/skills/
git commit -m "$(cat <<'EOF'
fix(F019-P1): dangling symlink 变 error + mount-skills --prune 模式

**What**: check-skills.ts 检测 dangling / orphan symlink 并 exit 1；
mount-skills.sh 增 --prune flag 清三挂载点失效 link；顺手清除
.agents/.gemini/ 现有 6 个 dangling (ask-dont-guess /
hardline-review / merge-approval-gate × 2)。

**Why**: F019-P1 基建清理。manifest 单一真相源被三挂载点 drift
破坏——`.claude/` 清了但 `.agents/.gemini/` 没跟上，3 个指向已删
除目录的 symlink 遗留至今。

[黄仁勋/Opus-47 🐾]
EOF
)"
```

---

### Task 1.3: 写 `multi-agent-skills/BOOTSTRAP.md`

**Files:**
- Create: `multi-agent-skills/BOOTSTRAP.md`

**Step 1: 收集真相源数据**

```
# 列 manifest 里所有 skill + description + slashCommand + next
npx tsx -e "const {parse} = require('yaml'); const fs = require('fs'); const doc = parse(fs.readFileSync('multi-agent-skills/manifest.yaml','utf8')); for (const [name, e] of Object.entries(doc.skills)) { console.log(\`| \${name} | \${e.description.split('。')[0]} | \${(e.slashCommands||[]).map(c=>c.name).join(',')||'—'} | \${(e.next||[]).join(',')||'—'} |\`) }"
```

**Step 2: 写 BOOTSTRAP.md**

内容（对标 clowder-ai 结构，本地化为我们三 agent 名字）：

```markdown
# Multi-Agent Skills Bootstrap

<EXTREMELY_IMPORTANT>
你已加载 Multi-Agent Skills。路由规则定义在 `multi-agent-skills/manifest.yaml`。

## Skills 列表（15 个）

### 开发流程链
\`\`\`
feat-lifecycle → Design Gate → writing-plans → worktree → tdd
    → quality-gate → acceptance-guardian → requesting-review → receiving-review
    → merge-gate → feat-lifecycle(完成)
\`\`\`

### 所有 Skills（按触发场景查表）

| Skill | 触发场景 | Slash | Next |
|-------|---------|-------|------|
| feat-lifecycle | 新功能立项 / 讨论 / 完成 | /feat | writing-plans |
| writing-plans | 写实施计划 | — | worktree |
| worktree | 开始写代码（创建隔离环境） | — | tdd |
| tdd | 红绿重构 | — | quality-gate |
| quality-gate | 开发完自检 | — | acceptance-guardian |
| acceptance-guardian | 独立验收（零上下文守护） | — | requesting-review |
| requesting-review | 请 review | — | receiving-review |
| code-review | 做 code review | — | — |
| receiving-review | 收到 review 反馈并修复 | — | merge-gate |
| merge-gate | 门禁→PR→merge | — | feat-lifecycle |
| cross-role-handoff | 跨角色交接 / 传话 | — | — |
| collaborative-thinking | brainstorm / 多 agent 讨论 / 收敛 | /think | — |
| debugging | bug 调试 / 报错定位 | — | — |
| self-evolution | scope 偏 / 重复错误 / 流程改进 / 知识沉淀 | — | — |
| writing-skills | 写新 skill / 修改 skill | — | — |

### 参考文件（refs/，按需读取）

| 文件 | 内容 |
|------|------|
| `refs/shared-rules.md` | 三人共用协作规则（单一真相源） |
| `refs/feature-doc-template.md` | Feature doc 模板 |
| `refs/bug-diagnosis-capsule.md` | Bug 诊断胶囊模板 |

## 关键规则

1. **Skill 适用就必须加载，没有选择** —— 看 shared-rules.md 铁律 6
2. **完整流程链**：feat-lifecycle → writing-plans → worktree → tdd → quality-gate → acceptance-guardian → requesting-review → receiving-review → merge-gate
3. **三条铁律**：数据神圣不可删 / 进程自保 / 配置不可变
4. **共用规则在 `refs/shared-rules.md`**（不在各 agent 文件里重复）

## 使用方式

- **黄仁勋（Claude）**：Skills 自动触发（`.claude/skills/`，Claude CLI 原生 discovery）
- **范德彪（Codex）**：Skills 自动触发（`.agents/skills/`，Codex CLI 项目级 discovery）
- **桂芬（Gemini）**：Skills 自动触发（`.gemini/skills/`，Gemini CLI 项目级 discovery）

三个挂载点由 `scripts/mount-skills.sh` 维护，`pnpm check:skills` 校验 drift。

## 新增/修改 skill

1. 在 `multi-agent-skills/{name}/` 创建 SKILL.md
2. 在 `manifest.yaml` 添加路由条目
3. 运行 `pnpm mount-skills` 重建三挂载点
4. 运行 `pnpm check:skills` 验证

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.
</EXTREMELY_IMPORTANT>
```

**Step 3: 验证**

```
pnpm check:skills
cat multi-agent-skills/BOOTSTRAP.md | grep -c "^| " # 表格行数
# 预期：≥ 15 个 skill 行
```

**Step 4: Commit**

```bash
git add multi-agent-skills/BOOTSTRAP.md
git commit -m "$(cat <<'EOF'
docs(F019-P1): 新增 multi-agent-skills/BOOTSTRAP.md

**What**: 对标 clowder-ai 的 cat-cafe-skills/BOOTSTRAP.md，补写压缩
选择表 + <EXTREMELY_IMPORTANT> 合规钳 + 三 CLI 加载方式说明。

**Why**: CLI 原生 discovery 只做"skill 存在感"，不做 (a) 压缩选
择表（N 个 skill 的 description 全注入 context 是浪费）(b) 合规
钳（XML 硬标签"MUST USE"行为压力）(c) 三 CLI 加载方式差异说
明——这三件是 CLI discovery 的补位。

[黄仁勋/Opus-47 🐾]
EOF
)"
```

---

### Task 1.4: `manifest.yaml` 的 `sop_navigation` 补 `hard_rules` / `pitfalls`（可选，不阻塞）

**Files:**
- Modify: `multi-agent-skills/manifest.yaml` — 如果已有 `sop_navigation` 块则补字段；无则按 clowder-ai 模板新增

**Step 1: 检查现状**

```
grep -n "sop_navigation" multi-agent-skills/manifest.yaml
```

如果**没有**则按 `reference-code/clowder-ai/cat-cafe-skills/manifest.yaml:661-703` 结构新增（改 Redis → SQLite、改猫名 → 人名）；如果**有**则补 `hard_rules` / `pitfalls` 数组。

**Step 2: 验证**

```
pnpm check:skills
```

**Step 3: Commit**

```bash
git add multi-agent-skills/manifest.yaml
git commit -m "docs(F019-P1): manifest sop_navigation 补 hard_rules/pitfalls

对标 clowder-ai cat-cafe-skills/manifest.yaml:661-703，每个 stage
补硬规则和常见坑。为 P3 sopStageHint 提供导航内容源。

[黄仁勋/Opus-47 🐾]"
```

---

### Phase 1 退出条件

- [ ] `pnpm check:skills` 全绿，0 dangling-symlink error
- [ ] `.agents/skills/` + `.gemini/skills/` 没有指向已删除目录的 symlink
- [ ] `multi-agent-skills/BOOTSTRAP.md` 存在 + 覆盖 15 个 skill
- [ ] `pnpm mount-skills:prune` 幂等（跑两次输出一致）
- [ ] `manifest.yaml` `sop_navigation` 六个 stage 都有 `hard_rules` + `pitfalls`（可选项）
- [ ] 三个 commit（1.1+1.2 合一 / 1.3 / 1.4），每个独立可 review

---

## Phase 2: WorkflowSopService 状态机（2~3d）

**目标**：新增持久化 SOP 状态机，不接入任何调用方。P2 结束时代码存在但未使用——P3 才把它接进 invocation flow 和 callback。

### Task 2.1: drizzle schema + migration — `workflow_sop` 表 + `threads.backlog_item_id` 列

**Files:**
- Modify: `packages/api/src/db/schema.ts`（文件末尾加 workflowSop 表；threads 表加 backlogItemId 列）
- Modify: `packages/api/src/db/drizzle-instance.ts:93-108`（CREATE TABLE SQL 同步加列）
- Modify: `packages/api/src/db/sqlite.ts`（CREATE TABLE SQL 同步 + ThreadRecord 类型加 backlogItemId）
- Test: `packages/api/src/db/schema.test.ts`

**Step 1: 写失败测试**

Modify `packages/api/src/db/schema.test.ts` — 加入：

```typescript
describe("workflow_sop schema", () => {
  it("workflowSop has expected columns", () => {
    const cols = Object.keys(schema.workflowSop)
    assert.ok(cols.includes("backlogItemId"))
    assert.ok(cols.includes("featureId"))
    assert.ok(cols.includes("stage"))
    assert.ok(cols.includes("batonHolder"))
    assert.ok(cols.includes("nextSkill"))
    assert.ok(cols.includes("resumeCapsule"))
    assert.ok(cols.includes("checks"))
    assert.ok(cols.includes("version"))
  })

  it("threads has backlog_item_id column", () => {
    assert.ok("backlogItemId" in schema.threads)
  })
})
```

**Step 2: 跑测试确认失败**

```
pnpm --filter @multi-agent/api test -- schema.test.ts
```
预期：FAIL（workflowSop undefined / backlogItemId undefined）

**Step 3: 最小实现 — schema.ts 加定义**

在 `packages/api/src/db/schema.ts` 文件末尾添加：

```typescript
export const workflowSop = sqliteTable(
  "workflow_sop",
  {
    backlogItemId: text("backlog_item_id").primaryKey(),
    featureId: text("feature_id").notNull(),
    stage: text("stage").notNull(),
    batonHolder: text("baton_holder"),
    nextSkill: text("next_skill"),
    resumeCapsule: text("resume_capsule").notNull().default("{}"),
    checks: text("checks").notNull().default("{}"),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("idx_workflow_sop_feature_id").on(table.featureId),
    index("idx_workflow_sop_stage").on(table.stage),
  ],
)
```

修改 `threads` 表定义，添加：
```typescript
  backlogItemId: text("backlog_item_id"),
```
（放在 `sopBookmark` 下方，nullable）

**Step 4: 同步 CREATE TABLE SQL**

`packages/api/src/db/drizzle-instance.ts:93-108` 的 threads CREATE TABLE 加一列：
```sql
backlog_item_id TEXT,
```

文件末尾加：
```sql
CREATE TABLE IF NOT EXISTS workflow_sop (
  backlog_item_id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  baton_holder TEXT,
  next_skill TEXT,
  resume_capsule TEXT NOT NULL DEFAULT '{}',
  checks TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_sop_feature_id ON workflow_sop(feature_id);
CREATE INDEX IF NOT EXISTS idx_workflow_sop_stage ON workflow_sop(stage);
```

同样改 `packages/api/src/db/sqlite.ts` 里的 DDL 段 + `ThreadRecord` type 加 `backlogItemId: string | null`。

**对老 DB 的迁移**：`ALTER TABLE threads ADD COLUMN backlog_item_id TEXT;` —— 按本项目惯例放在 `drizzle-instance.ts` 初始化时执行一次（借鉴 F011 的迁移模式，具体位置 code-time 看 F011 留下的迁移 helper）。**铁律**：不动现有行。

**Step 5: 跑测试确认通过**

```
pnpm --filter @multi-agent/api test -- schema.test.ts
```
预期：PASS

**Step 6: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/db/drizzle-instance.ts packages/api/src/db/sqlite.ts packages/api/src/db/schema.test.ts
git commit -m "feat(F019-P2): workflow_sop 表 + threads.backlog_item_id 列

新表 workflow_sop（stage 枚举 / batonHolder / resumeCapsule JSON /
checks JSON / 乐观锁 version）+ threads 表加 backlog_item_id 做
thread → feature 绑定。附 ALTER TABLE 迁移（nullable，不破坏老行）。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 2.2: `workflow-sop-repository.ts` — CRUD + 乐观锁

**Files:**
- Create: `packages/api/src/db/repositories/workflow-sop-repository.ts`
- Test: `packages/api/src/db/repositories/workflow-sop-repository.test.ts`

**Step 1: 写失败测试（覆盖 CRUD + 乐观锁）**

```typescript
// packages/api/src/db/repositories/workflow-sop-repository.test.ts
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { WorkflowSopRepository } from "./workflow-sop-repository.js"
import { createTempDb } from "../test-helpers.js"  // 假设已有，F011 建立的模式

describe("WorkflowSopRepository", () => {
  let repo: WorkflowSopRepository
  let cleanup: () => void

  beforeEach(() => {
    const t = createTempDb()
    repo = new WorkflowSopRepository(t.db)
    cleanup = t.cleanup
  })

  it("upsert inserts new row with version=1", () => {
    const result = repo.upsert({
      backlogItemId: "F019",
      featureId: "F019",
      stage: "kickoff",
      updatedBy: "黄仁勋",
    })
    assert.equal(result.version, 1)
    assert.equal(result.stage, "kickoff")
  })

  it("upsert increments version on update", () => {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    const second = repo.upsert({ backlogItemId: "F019", stage: "impl", updatedBy: "x" })
    assert.equal(second.version, 2)
    assert.equal(second.stage, "impl")
  })

  it("upsert with expectedVersion mismatch throws OptimisticLockError", () => {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    // current version = 1
    assert.throws(
      () => repo.upsert({ backlogItemId: "F019", stage: "impl", updatedBy: "x", expectedVersion: 99 }),
      /OptimisticLockError/,
    )
  })

  it("get returns null for unknown backlogItemId", () => {
    assert.equal(repo.get("F999"), null)
  })

  it("get returns parsed resumeCapsule and checks as objects (not strings)", () => {
    repo.upsert({
      backlogItemId: "F019", featureId: "F019", stage: "impl", updatedBy: "x",
      resumeCapsule: { goal: "a", done: ["b"], currentFocus: "c" },
      checks: { remoteMainSynced: "verified" },
    })
    const got = repo.get("F019")
    assert.deepEqual(got?.resumeCapsule, { goal: "a", done: ["b"], currentFocus: "c" })
    assert.equal(got?.checks.remoteMainSynced, "verified")
  })

  it("delete removes row", () => {
    repo.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    repo.delete("F019")
    assert.equal(repo.get("F019"), null)
  })
})
```

**Step 2: 跑测试确认失败**

```
pnpm --filter @multi-agent/api test -- workflow-sop-repository
```
预期：FAIL（repo 文件不存在）

**Step 3: 最小实现**

Create `packages/api/src/db/repositories/workflow-sop-repository.ts`：

```typescript
import { eq } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { workflowSop } from "../schema.js"
import type {
  WorkflowSop, UpdateSopInput, ResumeCapsule, SopChecks,
} from "../../services/workflow-sop-types.js"  // types-only module, 避免 service 依赖 repo

export class OptimisticLockError extends Error {
  constructor(backlogItemId: string, expected: number, actual: number) {
    super(`OptimisticLockError: ${backlogItemId} expected version=${expected}, actual=${actual}`)
    this.name = "OptimisticLockError"
  }
}

export class WorkflowSopRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  get(backlogItemId: string): WorkflowSop | null {
    const row = this.db.select().from(workflowSop)
      .where(eq(workflowSop.backlogItemId, backlogItemId)).get()
    if (!row) return null
    return this.fromRow(row)
  }

  upsert(input: UpdateSopInput): WorkflowSop {
    const existing = this.get(input.backlogItemId)

    if (input.expectedVersion !== undefined) {
      const actual = existing?.version ?? 0
      if (actual !== input.expectedVersion) {
        throw new OptimisticLockError(input.backlogItemId, input.expectedVersion, actual)
      }
    }

    const now = new Date().toISOString()
    const nextVersion = (existing?.version ?? 0) + 1

    const merged: WorkflowSop = {
      backlogItemId: input.backlogItemId,
      featureId: input.featureId ?? existing?.featureId ?? input.backlogItemId,
      stage: input.stage ?? existing?.stage ?? "kickoff",
      batonHolder: input.batonHolder !== undefined ? input.batonHolder : (existing?.batonHolder ?? null),
      nextSkill: input.nextSkill !== undefined ? input.nextSkill : (existing?.nextSkill ?? null),
      resumeCapsule: { ...(existing?.resumeCapsule ?? { goal: "", done: [], currentFocus: "" }), ...(input.resumeCapsule ?? {}) },
      checks: { ...(existing?.checks ?? {}), ...(input.checks ?? {}) } as SopChecks,
      version: nextVersion,
      updatedAt: now,
      updatedBy: input.updatedBy,
    }

    if (existing) {
      this.db.update(workflowSop)
        .set(this.toRow(merged))
        .where(eq(workflowSop.backlogItemId, input.backlogItemId))
        .run()
    } else {
      this.db.insert(workflowSop).values(this.toRow(merged)).run()
    }

    return merged
  }

  delete(backlogItemId: string): void {
    this.db.delete(workflowSop).where(eq(workflowSop.backlogItemId, backlogItemId)).run()
  }

  private fromRow(row: any): WorkflowSop {
    return {
      ...row,
      resumeCapsule: JSON.parse(row.resumeCapsule || "{}"),
      checks: JSON.parse(row.checks || "{}"),
    }
  }

  private toRow(sop: WorkflowSop) {
    return {
      ...sop,
      resumeCapsule: JSON.stringify(sop.resumeCapsule),
      checks: JSON.stringify(sop.checks),
    }
  }
}
```

**Step 4: 跑测试确认通过**

```
pnpm --filter @multi-agent/api test -- workflow-sop-repository
```
预期：PASS（6 tests）

**Step 5: Commit**

```bash
git add packages/api/src/db/repositories/workflow-sop-repository.ts packages/api/src/db/repositories/workflow-sop-repository.test.ts packages/api/src/services/workflow-sop-types.ts
git commit -m "feat(F019-P2): WorkflowSopRepository — CRUD + 乐观锁

upsert/get/delete，乐观锁通过 expectedVersion 参数触发 OptimisticLockError。
resumeCapsule/checks 作为 JSON 列存储，fromRow/toRow 透明转换。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 2.3: `workflow-sop-service.ts` — Service 层包装

**Files:**
- Create: `packages/api/src/services/workflow-sop-service.ts`
- Create: `packages/api/src/services/workflow-sop-types.ts`（types-only，已在 Task 2.2 创建）
- Test: `packages/api/src/services/workflow-sop-service.test.ts`

**Step 1: 写失败测试**

```typescript
// packages/api/src/services/workflow-sop-service.test.ts
describe("WorkflowSopService", () => {
  it("upsert delegates to repository", () => {
    const mockRepo = { get: () => null, upsert: (i: any) => ({ ...i, version: 1, updatedAt: "x" }) } as any
    const svc = new WorkflowSopService(mockRepo)
    const result = svc.upsert({ backlogItemId: "F019", featureId: "F019", stage: "kickoff", updatedBy: "x" })
    assert.equal(result.version, 1)
  })

  it("buildHint returns null when no sop found", () => {
    const mockRepo = { get: () => null } as any
    const svc = new WorkflowSopService(mockRepo)
    assert.equal(svc.buildHint("F019"), null)
  })

  it("buildHint returns formatted string when sop found", () => {
    const mockRepo = { get: () => ({ featureId: "F019", stage: "impl", nextSkill: "tdd" }) } as any
    const svc = new WorkflowSopService(mockRepo)
    assert.equal(svc.buildHint("F019"), "SOP: F019 stage=impl → load skill: tdd")
  })

  it("buildHint omits load-skill suffix when nextSkill is null", () => {
    const mockRepo = { get: () => ({ featureId: "F019", stage: "completion", nextSkill: null }) } as any
    const svc = new WorkflowSopService(mockRepo)
    assert.equal(svc.buildHint("F019"), "SOP: F019 stage=completion")
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 最小实现**

```typescript
// packages/api/src/services/workflow-sop-service.ts
import type { WorkflowSopRepository } from "../db/repositories/workflow-sop-repository.js"
import type { WorkflowSop, UpdateSopInput } from "./workflow-sop-types.js"

export class WorkflowSopService {
  constructor(private repo: WorkflowSopRepository) {}

  get(backlogItemId: string): WorkflowSop | null {
    return this.repo.get(backlogItemId)
  }

  upsert(input: UpdateSopInput): WorkflowSop {
    return this.repo.upsert(input)
  }

  delete(backlogItemId: string): void {
    this.repo.delete(backlogItemId)
  }

  /** 构建告示牌注入字符串；无绑定或无记录 → null */
  buildHint(backlogItemId: string | null | undefined): string | null {
    if (!backlogItemId) return null
    const sop = this.repo.get(backlogItemId)
    if (!sop) return null
    const suffix = sop.nextSkill ? ` → load skill: ${sop.nextSkill}` : ""
    return `SOP: ${sop.featureId} stage=${sop.stage}${suffix}`
  }
}
```

**Step 4: 跑测试确认通过**

**Step 5: Commit**

```bash
git commit -m "feat(F019-P2): WorkflowSopService — 告示牌引擎

Service 层包装 repo，提供 buildHint() 生成一行 sopStageHint 字符串。
形如 'SOP: F019 stage=impl → load skill: tdd'。无绑定 / 无记录返回 null。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 2.4: Server bootstrap 里 wire up Service 但**不接入 invocation flow**

**Files:**
- Modify: `packages/api/src/server.ts`

**Step 1: 加实例化（让 service 可注入，但暂不被调用）**

在 `server.ts` 里 SkillRegistry 初始化附近加：

```typescript
import { WorkflowSopService } from "./services/workflow-sop-service.js"
import { WorkflowSopRepository } from "./db/repositories/workflow-sop-repository.js"

// ...
const workflowSopRepo = new WorkflowSopRepository(drizzleDb)
const workflowSopService = new WorkflowSopService(workflowSopRepo)
// 先不 .setWorkflowSopService(messages, workflowSopService) —— P3 才接入
```

**Step 2: 跑全量测试确认不破坏现有**

```
pnpm check  # typecheck + test + check-docs + check-skills + lint
```
预期：全绿

**Step 3: Commit**

```bash
git commit -m "feat(F019-P2): server bootstrap 加 WorkflowSopService 实例（暂未接入 flow）

[黄仁勋/Opus-47 🐾]"
```

---

### Phase 2 退出条件

- [ ] `schema.ts` 含 `workflowSop` 表 + `threads.backlogItemId` 列
- [ ] 迁移 ALTER TABLE 对老 DB 幂等（跑两次不报错）
- [ ] `WorkflowSopRepository` 6 个测试通过（含乐观锁）
- [ ] `WorkflowSopService.buildHint` 4 个测试通过
- [ ] `server.ts` 实例化成功但未调用任何链路
- [ ] `pnpm check` 全绿
- [ ] 4 个原子 commit（2.1 / 2.2 / 2.3 / 2.4）

---

## Phase 3: sopStageHint 注入 + update-workflow-sop 双通道（1.5d）

**目标**：把 P2 构建好的 Service 真正接入 — system prompt 注入 + HTTP/MCP callback。P3 完成后，Mode B 讨论的扇入者就能看到 `SOP: ... → load skill: collaborative-thinking` 并主动加载。

### Task 3.1: `agent-prompts.ts` 新增 `buildSystemPromptWithHints`

**Files:**
- Modify: `packages/api/src/runtime/agent-prompts.ts`（加函数，不动 `AGENT_SYSTEM_PROMPTS` 常量）
- Test: `packages/api/src/runtime/agent-prompts.test.ts`

**Step 1: 写失败测试**

加到 `agent-prompts.test.ts`：

```typescript
describe("buildSystemPromptWithHints", () => {
  it("appends sopStageHint line when context has it", () => {
    const prompt = buildSystemPromptWithHints("claude", {
      sopStageHint: { featureId: "F019", stage: "impl", suggestedSkill: "tdd" },
    })
    assert.ok(prompt.endsWith("\n\nSOP: F019 stage=impl → load skill: tdd"))
  })

  it("returns base prompt unchanged when no sopStageHint", () => {
    const base = AGENT_SYSTEM_PROMPTS.claude
    const prompt = buildSystemPromptWithHints("claude", {})
    assert.equal(prompt, base)
  })

  it("omits → load skill suffix when suggestedSkill is null", () => {
    const prompt = buildSystemPromptWithHints("claude", {
      sopStageHint: { featureId: "F019", stage: "completion", suggestedSkill: null },
    })
    assert.ok(prompt.endsWith("\n\nSOP: F019 stage=completion"))
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 最小实现**

在 `agent-prompts.ts` 末尾加：

```typescript
export interface InvocationContext {
  sopStageHint?: {
    featureId: string
    stage: string
    suggestedSkill: string | null
  }
}

export function buildSystemPromptWithHints(
  provider: Provider,
  ctx: InvocationContext,
): string {
  const base = AGENT_SYSTEM_PROMPTS[provider]
  if (!ctx.sopStageHint) return base
  const { featureId, stage, suggestedSkill } = ctx.sopStageHint
  const suffix = suggestedSkill ? ` → load skill: ${suggestedSkill}` : ""
  return `${base}\n\nSOP: ${featureId} stage=${stage}${suffix}`
}
```

**Step 4: 跑测试确认通过**

**Step 5: Commit**

```bash
git commit -m "feat(F019-P3): buildSystemPromptWithHints — sopStageHint 注入函数

保留 AGENT_SYSTEM_PROMPTS 静态常量，新函数在其基础上追加一行
sopStageHint 告示。Provider 无关；caller 传 InvocationContext。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 3.2: `cli-orchestrator.ts` 接入 per-invocation context

**Files:**
- Modify: `packages/api/src/runtime/cli-orchestrator.ts`（runTurn options 加 sopStageHint）
- Modify: `packages/api/src/services/message-service.ts`（组装 runTurn 调用处时查 WorkflowSopService）
- Test: `packages/api/src/runtime/cli-orchestrator.test.ts`

**Step 1: 写失败测试**

```typescript
// cli-orchestrator.test.ts 加用例
it("passes sopStageHint through to MULTI_AGENT_SYSTEM_PROMPT env", async () => {
  const mockSpawn = jest.fn(...)  // 或 nock 风格拦截
  await runTurn({
    // ... existing ...
    sopStageHint: { featureId: "F019", stage: "impl", suggestedSkill: "tdd" },
  })
  const env = mockSpawn.mock.calls[0][2].env
  assert.ok(env.MULTI_AGENT_SYSTEM_PROMPT.endsWith("SOP: F019 stage=impl → load skill: tdd"))
})
```

**Step 2: 跑测试确认失败**

**Step 3: 最小实现**

`cli-orchestrator.ts` 的 RunTurnOptions 加：

```typescript
export interface RunTurnOptions {
  // ... existing
  sopStageHint?: {
    featureId: string
    stage: string
    suggestedSkill: string | null
  }
}
```

替换 `options.systemPrompt` 构建逻辑（L98 附近）：

```typescript
// 原：MULTI_AGENT_SYSTEM_PROMPT: options.systemPrompt ?? ""
// 改：
const effectivePrompt = options.systemPrompt
  ? options.systemPrompt
  : buildSystemPromptWithHints(options.provider, { sopStageHint: options.sopStageHint })

// ...
env: {
  MULTI_AGENT_SYSTEM_PROMPT: effectivePrompt,
  // ...
}
```

`message-service.ts` 在 runTurn 调用处（搜索 `runTurn(` 调用，约 L898 附近），注入：

```typescript
const sop = this.workflowSopService?.get(thread.backlogItemId ?? "")
const sopStageHint = sop ? { featureId: sop.featureId, stage: sop.stage, suggestedSkill: sop.nextSkill } : undefined

await runTurn({
  // ... existing ...
  sopStageHint,
})
```

**Step 4: wire MessageService 吃 WorkflowSopService**

`message-service.ts` 加 setter：

```typescript
private workflowSopService: WorkflowSopService | null = null
setWorkflowSopService(svc: WorkflowSopService) { this.workflowSopService = svc }
```

`server.ts` 在 `messages.setSkillRegistry(skillRegistry)` 附近加：
```typescript
messages.setWorkflowSopService(workflowSopService)
```

**Step 5: 跑全量测试**

```
pnpm check
```
预期：全绿

**Step 6: Commit**

```bash
git commit -m "feat(F019-P3): sopStageHint 接入 runTurn → system prompt

cli-orchestrator.runTurn 新 options.sopStageHint；消息调度时 MessageService
通过 thread.backlogItemId 查 WorkflowSopService，把告示牌一行追加到
MULTI_AGENT_SYSTEM_PROMPT env。无绑定 → 行为与改前一致。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 3.3: HTTP callback `POST /api/callbacks/update-workflow-sop`

**Files:**
- Modify: `packages/api/src/routes/callbacks.ts`（加 endpoint）
- Test: `packages/api/src/routes/callbacks.test.ts`

**Step 1: 写失败测试（沿用 callbacks.test.ts 的注入方式）**

```typescript
describe("POST /api/callbacks/update-workflow-sop", () => {
  it("upserts sop with version=1 for new entry", async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/callbacks/update-workflow-sop",
      payload: {
        invocationId: "inv-1",
        callbackToken: "token-valid",
        backlogItemId: "F019",
        featureId: "F019",
        stage: "impl",
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.sop.version, 1)
    assert.equal(body.sop.stage, "impl")
  })

  it("returns 409 on optimistic lock mismatch", async () => {
    const app = await buildTestApp()
    // prep: v1 exists
    await app.inject({
      method: "POST", url: "/api/callbacks/update-workflow-sop",
      payload: { invocationId: "i1", callbackToken: "t", backlogItemId: "F019", featureId: "F019", stage: "impl" },
    })
    const res = await app.inject({
      method: "POST", url: "/api/callbacks/update-workflow-sop",
      payload: { invocationId: "i2", callbackToken: "t", backlogItemId: "F019", stage: "review", expectedVersion: 99 },
    })
    assert.equal(res.statusCode, 409)
  })

  it("rejects invalid stage with 400", async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: "POST", url: "/api/callbacks/update-workflow-sop",
      payload: { invocationId: "i", callbackToken: "t", backlogItemId: "F019", featureId: "F019", stage: "invalid_stage" },
    })
    assert.equal(res.statusCode, 400)
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 最小实现**

`callbacks.ts` 加 endpoint（参照现有 `/api/callbacks/post-message` 的 auth 和错误处理模式）：

```typescript
import { z } from "zod"
import { OptimisticLockError } from "../db/repositories/workflow-sop-repository.js"

const SOP_STAGES = ["kickoff", "impl", "quality_gate", "review", "merge", "completion"] as const
const updateSopSchema = callbackAuthSchema.extend({
  backlogItemId: z.string().min(1),
  featureId: z.string().optional(),
  stage: z.enum(SOP_STAGES).optional(),
  batonHolder: z.string().nullable().optional(),
  nextSkill: z.string().nullable().optional(),
  resumeCapsule: z.object({
    goal: z.string().optional(),
    done: z.array(z.string()).optional(),
    currentFocus: z.string().optional(),
  }).partial().optional(),
  checks: z.record(z.enum(["attested", "verified", "unknown"])).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
})

app.post("/api/callbacks/update-workflow-sop", async (request, reply) => {
  const parsed = updateSopSchema.safeParse(request.body)
  if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })

  const { invocationId, callbackToken, ...input } = parsed.data
  const caller = await resolveCallerAgentId(invocationId, callbackToken, deps)
  if (!caller) return reply.code(401).send({ ok: false, error: "unauthorized" })

  try {
    const sop = workflowSopService.upsert({ ...input, updatedBy: caller })
    return reply.code(200).send({ ok: true, sop })
  } catch (e) {
    if (e instanceof OptimisticLockError) return reply.code(409).send({ ok: false, error: e.message })
    throw e
  }
})
```

注意：`workflowSopService` 需要通过 route 注册时的 deps 注入 —— 改 `server.ts` 的 routes 注册加这个 dep（参照现有 `messageService` 注入模式）。

**Step 4: 跑测试确认通过**

**Step 5: Commit**

```bash
git commit -m "feat(F019-P3): POST /api/callbacks/update-workflow-sop

Agent 可通过 HTTP callback 推进 WorkflowSop stage / baton /
checks。路径和 post-message 同权限模型（invocationId + token）。
乐观锁失配返回 409，stage enum 校验 400。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 3.4: MCP tool `update_workflow_sop` — 与 HTTP 通道共享 Service 方法

**Files:**
- Modify: `packages/api/src/mcp/server.ts`（加 tool definition）
- Test: `packages/api/src/mcp/server.test.ts`

**Step 1: 写失败测试**

```typescript
describe("MCP tool update_workflow_sop", () => {
  it("upserts sop via MCP bridge", async () => {
    const { server, service } = buildTestMcpServer()
    const result = await invokeMcpTool(server, "update_workflow_sop", {
      backlogItemId: "F019",
      featureId: "F019",
      stage: "impl",
    })
    assert.equal(result.isError, false)
    assert.deepEqual(service.get("F019")?.stage, "impl")
  })
})
```

**Step 2: 最小实现**

`mcp/server.ts` 加 tool（参照 `parallel_think` 或现有 tool 的注册模式）：

```typescript
server.tool(
  "update_workflow_sop",
  {
    description: "推进 WorkflowSop stage（告示牌）",
    inputSchema: {
      type: "object",
      required: ["backlogItemId"],
      properties: {
        backlogItemId: { type: "string" },
        featureId: { type: "string" },
        stage: { type: "string", enum: SOP_STAGES },
        batonHolder: { type: "string" },
        nextSkill: { type: "string" },
        resumeCapsule: { type: "object" },
        checks: { type: "object" },
        expectedVersion: { type: "integer" },
      },
    },
  },
  async (input) => {
    const caller = ctx.currentAgentId  // 通过 MCP 上下文
    try {
      const sop = workflowSopService.upsert({ ...input, updatedBy: caller })
      return { content: [{ type: "text", text: JSON.stringify(sop) }] }
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] }
    }
  },
)
```

**Step 3: 跑测试确认通过**

**Step 4: Commit**

```bash
git commit -m "feat(F019-P3): MCP tool update_workflow_sop — 与 HTTP 通道对等

Claude 通过 MCP 原生调用推进 stage，Codex/Gemini 走 HTTP callback fallback。
两路径共享 WorkflowSopService.upsert 行为一致。

[黄仁勋/Opus-47 🐾]"
```

---

### Phase 3 退出条件

- [ ] `buildSystemPromptWithHints` 3 个测试通过
- [ ] `cli-orchestrator` 传递 sopStageHint 到 env 测试通过
- [ ] `POST /api/callbacks/update-workflow-sop` 3 个测试通过（happy / 乐观锁 / 参数校验）
- [ ] MCP tool `update_workflow_sop` 测试通过
- [ ] `pnpm check` 全绿
- [ ] 手动 smoke test：插入一条 `workflow_sop` 行（`sqlite3` 命令）+ 绑定 thread → 跑一条消息 → 检查实际 system prompt 含 `SOP: ...` 行
- [ ] 4 个原子 commit（3.1 / 3.2 / 3.3 / 3.4）

---

## Phase 4: 砍老层 + 回归验证（1d）

**目标**：删除 `prependSkillHint` 相关代码，确认新机制接住所有旧能力，跑 AC7 重放验证。

### Task 4.1: 删除 `prependSkillHint` / `buildSkillHintLine` / `matchOrthogonalSkills`

**Files:**
- Modify: `packages/api/src/services/message-service.ts`
  - L65-74（LINEAR_FLOW_SKILLS + 注释段）
  - L731-734（prependSkillHint 调用点）
  - L1380-1414（Phase 1 header 区域中的 skillHint 构建，**只删 skillHint 相关，保留 phase1HeaderText**）
  - L1384-1386（buildSkillHintLine 调用）
  - L1652-1689（`matchOrthogonalSkills` / `prependSkillHint` / `buildSkillHintLine` 三个函数定义）
- Delete: `packages/api/src/services/message-service-skill-hint.test.ts`（整个文件）

**Step 1: 先跑现有测试建基线**

```
pnpm --filter @multi-agent/api test -- message-service
```
记录通过的测试数（基线）。

**Step 2: 精准删除**

```typescript
// L65-74: 删整段 LINEAR_FLOW_SKILLS 和那段注释（保留代码其他部分）
// L731-734: 替换
//   const effectiveContent = this.prependSkillHint(event.payload.content, thread.provider)
// 为
//   const effectiveContent = event.payload.content
// L1380-1414: 保留 phase1HeaderText 构建，删 skillHint 构建和传参；acceptance-guardian 检测逻辑保留
// L1652-1689: 删 matchOrthogonalSkills / prependSkillHint / buildSkillHintLine 三个私有方法
```

同时删除 `packages/api/src/services/message-service-skill-hint.test.ts` 整个文件（36 tests 测的是被删功能）。

**Step 3: 跑测试**

```
pnpm --filter @multi-agent/api test
```
预期：总 test 数减少（因为 skill-hint.test.ts 被删），但无 FAIL；其他测试全绿。

**Step 4: 跑 typecheck + lint**

```
pnpm check
```
预期：全绿。如有 unused import / unused variable 警告，清理。

**Step 5: 验证 grep 为空**

```
grep -rn "prependSkillHint\|buildSkillHintLine\|matchOrthogonalSkills" packages/api/src/
```
预期：空输出（只应保留在 git log 里）

**Step 6: Commit**

```bash
git commit -m "refactor(F019-P4): 砍 prependSkillHint 关键词注入层

删除 message-service.ts 的 prependSkillHint / buildSkillHintLine /
matchOrthogonalSkills / LINEAR_FLOW_SKILLS，连同 message-service-skill-hint.test.ts
整个文件。告示牌机制 (F019-P3 sopStageHint) 接替其功能。

保留 phase1-header.ts（那是 Mode B 路由策略，不是 skill hint 注入）。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 4.2: AC7 回归自动化测试 — "讨论一下" 重放

**Files:**
- Create: `packages/api/src/services/message-service.mode-b-replay.test.ts`

**Step 1: 写重放测试**

```typescript
describe("Mode B replay — collaborative-thinking bulletin board integration", () => {
  it("when feature bound, fan-in sees SOP hint and loads collaborative-thinking SKILL.md", async () => {
    // setup: create session-group with 3 threads (claude/codex/gemini),
    // bind backlogItemId=F019 to the group,
    // seed WorkflowSop with stage=impl suggestedSkill=collaborative-thinking
    const { messages, threadIds, workflowSopService } = await buildTestHarness()
    workflowSopService.upsert({
      backlogItemId: "F019", featureId: "F019", stage: "impl",
      nextSkill: "collaborative-thinking", updatedBy: "test",
    })
    bindBacklogItem(threadIds.claude, "F019")
    bindBacklogItem(threadIds.codex, "F019")
    bindBacklogItem(threadIds.gemini, "F019")

    // simulate user message "@黄仁勋 @范德彪 @桂芬 你们讨论一下 X"
    const systemPrompts = await captureSystemPromptsDuring(async () => {
      await messages.dispatch({ content: "@黄仁勋 @范德彪 @桂芬 你们讨论一下 X" })
    })

    // assert: each provider's system prompt ends with sopStageHint
    for (const provider of ["claude", "codex", "gemini"]) {
      assert.ok(
        systemPrompts[provider].includes("SOP: F019 stage=impl → load skill: collaborative-thinking"),
        `${provider} system prompt missing sopStageHint`,
      )
    }
  })

  it("when no feature bound, no sopStageHint in system prompt (backward compat)", async () => {
    const { messages, threadIds } = await buildTestHarness()
    // no binding, no workflow_sop row
    const systemPrompts = await captureSystemPromptsDuring(async () => {
      await messages.dispatch({ content: "@黄仁勋 some normal message" })
    })
    assert.ok(!systemPrompts.claude.includes("SOP:"))
  })
})
```

**Step 2: 跑测试**

```
pnpm --filter @multi-agent/api test -- mode-b-replay
```
预期：PASS（如有 harness 辅助函数缺失，按需在 test-helpers 里补）

**Step 3: Commit**

```bash
git commit -m "test(F019-P4): Mode B 重放 — 告示牌接管场景集成测试

AC7 自动化验证：feature-bound thread 的 dispatch flow 中，三个 agent 的
system prompt 都包含 sopStageHint 一行。无绑定场景保持与改前一致。

[黄仁勋/Opus-47 🐾]"
```

---

### Task 4.3: 人工 smoke test（上线前必做）

**Not a commit step** — 手工验证：

1. 启动 dev server：`pnpm dev`
2. 手动 SQL：`INSERT INTO workflow_sop (backlog_item_id, feature_id, stage, next_skill, version, updated_at, updated_by) VALUES ('F019', 'F019', 'impl', 'collaborative-thinking', 1, datetime('now'), 'manual');`
3. 手动 SQL：`UPDATE threads SET backlog_item_id='F019' WHERE session_group_id = '{your test session}';`
4. 在 UI 输入 `@黄仁勋 @范德彪 @桂芬 你们讨论一下 X`
5. 检查三个 thread 的回复：
   - 观察日志里 each CLI 的 `--append-system-prompt` 参数（或 env `MULTI_AGENT_SYSTEM_PROMPT`）末尾是否含 `SOP: F019 stage=impl → load skill: collaborative-thinking`
   - 观察 agent 的 `tool_events` 是否包含对 `collaborative-thinking/SKILL.md` 的读取
   - 查看生成的综合纪要是否含 Mode C 三件套"有/没有"回答
6. 跑 MCP tool 推进 stage：`/tool update_workflow_sop {backlogItemId:"F019",stage:"quality_gate"}`，再发一次消息，观察 system prompt 更新为 `stage=quality_gate`

**如果 smoke test 任一步骤失败**：不合入本 Phase 的 commits，回到 bug 点修复后重跑。

---

### Task 4.4: 收尾文档更新

**Files:**
- Modify: `docs/features/F019-skill-bulletin-board.md`（AC1~AC8 打勾，加 Completed 日期，Timeline 加 Phase 4 完成）

**Step 1: 改 status + Completed**

frontmatter `status: done`；正文加 `**Completed**: YYYY-MM-DD`。

**Step 2: Commit**

```bash
git commit -m "docs(F019-P4): mark feature as done

AC1-AC8 all ✅, Mode B/C 断档修复 + 三挂载点 drift 修复验证通过。

**What**: 告示牌机制完整接入 — WorkflowSopService + SQLite
持久化 + sopStageHint 注入 + HTTP/MCP 双通道推进 + 三挂载点
同步机制；prependSkillHint 旧层完全删除。

**Evolved from**: 无
**Blocks**: 无

[黄仁勋/Opus-47 🐾]"
```

**Step 3: ROADMAP 移位** —— 走 merge-gate 时在 merge 后做（本 Task 不做）。

---

### Phase 4 退出条件

- [ ] `grep prependSkillHint packages/` 返回 0 结果
- [ ] `message-service-skill-hint.test.ts` 文件不存在
- [ ] `mode-b-replay.test.ts` 通过
- [ ] 人工 smoke test 全部步骤通过
- [ ] `pnpm check` 全绿
- [ ] AC7 愿景对照三问全 ✅：跨 agent 交叉验证安排
- [ ] F019 feature doc status=done，Timeline 记录 P1~P4 完成日期

---

## 全局退出条件（合入 main / dev 前必做）

### 质量门禁
- [ ] `pnpm check` 全绿（typecheck / test / docs / skills / lint 全过）
- [ ] 新增测试：P2 `workflow-sop-repository.test.ts`（6）/ `workflow-sop-service.test.ts`（4）/ `schema.test.ts` 新增（2）/ P3 `agent-prompts.test.ts` 新增（3）/ `cli-orchestrator.test.ts` 新增（1）/ `callbacks.test.ts` 新增（3）/ `mcp/server.test.ts` 新增（1）/ P4 `mode-b-replay.test.ts`（2）+ `check-skills.dangling.test.ts`（1）—— 共 **23 个新测试**
- [ ] 删除测试：`message-service-skill-hint.test.ts` 整个文件（被废弃功能的测试）

### 独立验收（acceptance-guardian）
- [ ] @ 范德彪或桂芬（非作者）做愿景三问
- [ ] 证物对照表小孙原话→代码位置→测试名全匹配
- [ ] Bug Mode 回放："讨论一下" 场景 Phase 1 独立性保留 + Mode C 三件套触发

### Review
- [ ] `requesting-review` 发给范德彪（Codex 负责 code review 铁律）
- [ ] P1/P2 反馈走 `receiving-review`

### Merge
- [ ] `merge-gate` 走 squash merge 流程
- [ ] Merge 后 ROADMAP 从活跃表移到已完成表

---

## 关键风险 & 缓解

| 风险 | 缓解 |
|------|------|
| ALTER TABLE 对老 DB 迁移失败 | Task 2.1 有幂等迁移脚本；本地先备份 `data/multi-agent.sqlite` 再跑 |
| P4 删除 prependSkillHint 后发现某处隐式依赖 | P3 完成后先跑一周现网环境（feature flag？考虑 env `DISABLE_SKILL_HINT=1` 灰度）—— 本 plan 不加 flag，通过完整测试+smoke 兜底 |
| MCP tool 和 HTTP callback 语义漂移 | Task 3.3+3.4 共享同一 Service 方法；契约测试覆盖 |
| 三挂载点 prune 误删活 skill | `mount-skills.sh --prune` 只删 target 不存在的 symlink；prune 前先跑 `check:skills` 确认 manifest 干净 |
| sync-skill-mounts 在 CI 不跑，新人拉代码后本地 drift | `pnpm check:skills` 挂到 pre-commit（本 plan 已在 P1 task 1.1 的 check-skills 升级 error 级别）+ README 补一句"初次 setup 跑 `pnpm mount-skills`" |

---

## 依赖与前置条件

- ✅ F019 feature doc 已存在（commit 1f0dd93）
- ✅ F019 Design Gate 已过（self-evolution 讨论 + 小孙拍板 A）
- ✅ 当前 dev 分支基线绿（2026-04-17 pre-commit 通过 563 tests）
- 🟡 本 plan 实施时需要在 worktree（下一步 `worktree` skill 创建），**不在 dev 直接改**

## 下一步

→ `worktree` skill 创建 `.worktrees/F019-skill-bulletin-board/`
→ 在 worktree 中按 `tdd` skill 执行 P1 Task 1.1
