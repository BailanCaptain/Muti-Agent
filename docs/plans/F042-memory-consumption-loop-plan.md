# F042 记忆消费闭环（一期）Implementation Plan

**Feature:** F042 — `docs/features/F042-memory-consumption-loop.md`
**Goal:** 让「用→攒→提炼→喂回」四环里断掉的「喂回」环转起来：direct_turn 影子召回攒真实数据、采纳可度量、canonical 有生命周期、编译不再盲编。
**Acceptance Criteria:**（照抄 feature doc，本计划全覆盖）
- AC1 · direct_turn shadow 召回：coordinator 触发白名单扩 direct_turn，三态配置 `off|shadow|inject`（默认 shadow）；shadow = 全召回链真跑 + 写 prompt_audit，但不注入 prompt。验收：网页发普通消息 → prompt_audit 新增行（recall_trigger=direct_turn，含 queries/results），该轮 parts 无 recall-pack；开关三态各自生效。
- AC2 · 采纳度量：prompt_audit 扩 injected/candidate paths + 采纳判定 + 统计接口。schema 变更走 migration。主动提示两时机：①影子观察窗跑满（50 次 direct_turn 召回或 14 天先到为准）→ 主动发一次性小结（房间消息卡）；②攒满 30-50 条标注 → 提示可拍 rerank 立项。无常态推送。验收：真实消息跑批后统计接口返回非零数字，抽 3 条人工核对采纳判定方向正确；模拟窗口满 → 小结消息真发出。
- AC3 · canonical 生命周期：promote 时 sources.path 同源精确匹配正式区已有条目 → 强制显式 supersede/merge 选择；被替代条目退出召回面（search_wiki + preflight + adaptive-recall Level 2 同步过滤）；NHC 死链扫描排除 `_superseded`。验收：F031 双胞胎场景重放——收录新版后旧版被显式 supersede 且 search_wiki 搜不到；NHC 报告 0 条 _superseded 噪音。
- AC4 · 编译候选喂料：pre-compile 相似检索改接 wiki_entity_index（top-5 真实 score，替代 message_embeddings 误用）；sources[0].path 精确身份进 compile prompt。验收：正式区已有同源条目时重放收录 → dedup verdict ≠ new_entity 且给出正确 target；相关条目场景 cross_refs 非空。
- AC5 · 外部守活（轻）：进程外健康探针脚本 + 安装说明。验收：杀 API 后一个周期内报警；维护模式静默。

**Architecture:** 五件活各自独立落地、按 AC1→AC2→AC3→AC4→AC5 排序（AC2 依赖 AC1 的审计行，其余互不依赖）。全部骑现有机制：召回走 coordinator 白名单配置（不动 coordinator 本体）、度量走 prompt_audit 扩列、生命周期骑 `_rejected` 顶级归档目录同款惯例 + FTS 单点过滤、编译喂料注入生产已布线的 hybridWikiSearch、探针独立 .ps1。
**Tech Stack:** node:test（tsx --test 直跑）、Fastify 路由三段式、内联 MIGRATIONS 双镜像、PowerShell 5.1。

---

## 锚点核实记录（2026-07-10，dev HEAD `480d568`，四路独立核查）

计划里所有 file:line 均为当前 HEAD 实测，非审计期历史值。**关键修正与发现**：

1. message-service 真实路径是 `packages/api/src/services/message-service.ts`（3404 行），不是审计报告写的 `messages/`。
2. 飞书 IM 入站消息与网页共用 `handleSendMessage → runThreadTurn(scenario:"direct_turn")` 同一分支（`channel-gateway.ts:1188-1201` → `server.ts:949` injector=MessageService）——AC1 接通后 IM 自动获得同等行为，零额外接线。
3. NHC/MonthlySnapshot 的「报告」走 WS broadcast（警告 tab），**不落消息时间轴**；AC2 小结卡必须复用 F021 seal 先例 `appendSystemNoticeMessage`（`session-service.ts:488-493`，调用现场 `message-service.ts:2474-2487`）。
4. 飞书出站锚定 rootMessageId 必须回溯到 IM 入站行（`channel-gateway.ts:519-523`）——系统自发的小结卡**推不到 IM**。本期只发房间卡；IM 推送显式 deferred（见 Out of scope）。
5. migration 是内联数组**双镜像**：`drizzle-instance.ts:606-691`（INIT_SQL + MIGRATIONS）+ `sqlite.ts:562`（runAlterMigrations），加列必须两文件三处同步（INIT_SQL 建表语句、MIGRATIONS 数组、sqlite.ts 镜像）+ `schema.ts` Drizzle 类型。
6. 三处召回面（search_wiki / memory_preflight / adaptive-recall L2）底层共用同一 `WikiEntityFtsProvider` SQL 过滤（`wiki-entity-fts-provider.ts:131-133`，只滤 `/draft/` `/_drafts/`）+ `embedded-records-loader.ts:91` 的 `isDraftRelativePath` JS filter——AC3 退出召回面只需改这两点。
7. **毗邻现症（本计划顺手收编）**：`wiki_entity_index` 实测有 `_rejected|5` 行——demote 掉的条目今天仍在索引且可被搜到（indexer 动态枚举 `wiki/` 下所有目录当 bucket，`wiki-entity-indexer.ts:69-77`；FTS 无 `_rejected` 过滤条款）。AC3 的归档过滤谓词同时覆盖 `_superseded` 与 `_rejected`，一并修掉。
8. dedup target 无存在性校验：`post-compile.ts:90-103` 只做枚举结构校验，不像 cross_refs 那样过 `entityChecker.exists`（`post-compile.ts:43-58` deadRefs 先例）——AC4 补上，否则 LLM 编造 target 会静默落盘。
9. coordinator 自己的 `RecallScenario`（`adaptive-recall-coordinator.ts:41`）含 `direct_turn`；memory-preflight 的同名类型（`memory-preflight/types.ts:98-116`）只有 `turn`——两个不兼容同名类型，AC1 只碰前者，hard-gate 本期不接（见设计决策 D6）。

## 设计决策（实施中不再重议）

| # | 决策 | 理由 |
|---|------|------|
| D1 | shadow 召回**同步 await**（与 wake_up 同链），不 fire-and-forget | prompt_audit 单行写入含 recall 字段，拆两次写复杂化；`recall_total_ms` 列现成——影子期本来就是量延迟的，p95 太高再拆（数据说话） |
| D2 | 三态开关走 env `MULTI_AGENT_DIRECT_TURN_RECALL`（`off|shadow|inject`，缺省/非法值→`shadow`），boot 时读一次 | 对齐 `FEISHU_DEFAULT_PROVIDER` 字符串枚举惯例（`channel-config.ts:151`）；默认 shadow 无需改 .env 即生效（Iron Law 3 兼容） |
| D3 | 观察窗检查内联在 direct_turn 审计写入后（每 turn 顺手查一次计数），不新造 cron | 窗口满的瞬间必然有一个正在进行的 turn（第 50 次召回本身）→ 小结卡直接发进当前 thread，省掉「往哪个 thread 发」的解析；无 turn 则无数据可总结，不需要 cron 兜底 |
| D4 | 「标注」定义 = prompt_audit 中 `recall_adopted` 非 NULL 的行（召回非空且启发式跑过判定） | F042 无人工标注 UI（rerank 立项时再建）；采纳判定行是当前唯一可攒的标注形态 |
| D5 | AC3 归档 = 物理搬运到 `wiki/_superseded/<bucket>/<name>.md`（骑 demote→`wiki/_rejected/` 顶级目录同款惯例）+ 查询层无条件排除两个归档目录 | 文件仍在 wiki 树内：NHC deadSupersedes（`nightly-health-check.ts:301` 要求 supersedes 目标仍在实体集）不炸、可浏览可恢复；查询层过滤对齐 draft 的既有「index 全收、查询时滤」架构 |
| D6 | AC1 不接 hard-gate（detectRecallTrigger 继续 0 caller） | spec 白名单方案已定；hard-gate 的价值是「省成本的触发判定」，影子期要的恰是全量数据；且其 RecallScenario 类型与 coordinator 不兼容（锚点 9），接它 = 额外类型统一工程，YAGNI |
| D7 | 同源冲突的「合并」选项 = 前端引导中止（关弹窗 + 跳转旧条目），不做机器合并 | 内容合并只能人做；API 只需 supersede 一条真路径，「强制显式选择」的本义是拦住静默双胞胎 |
| D8 | wiki_events 扩 `"supersede"` action（union 加成员，text 列无需 migration） | 有 `recall_escalate`/`warning_raised` 扩枚举先例；复用 `"demote"` 会让审计账本供词失真 |
| D9 | AC4 候选检索注入生产 `hybridWikiSearch`（BM25+cosine，`server.ts:360` 已构造），pre-compile 加可选 dep，旧 message_embeddings 路径保留为无 dep 时的兜底 | 不新造检索器；旧路径留着让存量测试语义不变，生产装配点显式传新 dep |
| D10 | AC2 小结卡/rerank 提示的一次性保证走新 `app_state` KV 表（key/value/updated_at） | 仓库无通用状态表；查 messages 找历史卡片脆弱；KV 最小且可复用 |

## Out of scope（本计划不做）

- 小结卡推送到飞书 IM（rootMessageId 出站约束，锚点 4）——留待 IM 通道支持系统自发消息时另接。
- 人工标注 UI、rerank 转正、viewfinder 打磨、CLI preflight（feature doc 已列，触发条件不变）。
- `_rejected` 存量 5 行索引的清理（过滤生效后查询不可见；行本身随下次对应文件变动自然收敛，不专门清）。

---

## Task 1: AC1 · 三态配置解析器（纯函数）

**Files:**
- Create: `packages/api/src/orchestrator/direct-turn-recall-mode.ts`
- Test: `packages/api/src/orchestrator/direct-turn-recall-mode.test.ts`

**Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict"
import test from "node:test"
import { parseDirectTurnRecallMode, resolveTriggerScenarios } from "./direct-turn-recall-mode"

test("parseDirectTurnRecallMode: 合法值原样返回", () => {
  assert.equal(parseDirectTurnRecallMode("off"), "off")
  assert.equal(parseDirectTurnRecallMode("shadow"), "shadow")
  assert.equal(parseDirectTurnRecallMode("inject"), "inject")
})

test("parseDirectTurnRecallMode: 缺省/空串/非法值/大小写混杂 → shadow", () => {
  assert.equal(parseDirectTurnRecallMode(undefined), "shadow")
  assert.equal(parseDirectTurnRecallMode(""), "shadow")
  assert.equal(parseDirectTurnRecallMode("  INJECT "), "inject") // trim + lowercase
  assert.equal(parseDirectTurnRecallMode("banana"), "shadow")
})

test("resolveTriggerScenarios: off → 默认白名单（不含 direct_turn）", () => {
  assert.deepEqual(resolveTriggerScenarios("off"), ["wake_up", "a2a_handoff"])
})

test("resolveTriggerScenarios: shadow/inject → 白名单扩 direct_turn", () => {
  assert.deepEqual(resolveTriggerScenarios("shadow"), ["wake_up", "a2a_handoff", "direct_turn"])
  assert.deepEqual(resolveTriggerScenarios("inject"), ["wake_up", "a2a_handoff", "direct_turn"])
})
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/api/src/orchestrator/direct-turn-recall-mode.test.ts`
Expected: FAIL — Cannot find module './direct-turn-recall-mode'

**Step 3: Write minimal implementation**

```typescript
import type { RecallScenario } from "./adaptive-recall-coordinator"

/**
 * F042 AC1 · direct_turn 召回三态。
 *   off    — 维持 F027 现状：direct_turn scenario_skip，永不召回
 *   shadow — 全召回链真跑 + 写 prompt_audit，但不注入 prompt（默认：先攒数据再放开）
 *   inject — 召回结果真注入（与 wake_up 同等待遇）
 * env: MULTI_AGENT_DIRECT_TURN_RECALL，boot 读一次；非法值 fail-safe 到 shadow。
 */
export type DirectTurnRecallMode = "off" | "shadow" | "inject"

export function parseDirectTurnRecallMode(raw: string | undefined): DirectTurnRecallMode {
  const v = raw?.trim().toLowerCase()
  if (v === "off" || v === "inject") return v
  return "shadow"
}

const BASE_TRIGGER_SCENARIOS: ReadonlyArray<RecallScenario> = ["wake_up", "a2a_handoff"]

export function resolveTriggerScenarios(mode: DirectTurnRecallMode): ReadonlyArray<RecallScenario> {
  return mode === "off" ? BASE_TRIGGER_SCENARIOS : [...BASE_TRIGGER_SCENARIOS, "direct_turn"]
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/api/src/orchestrator/direct-turn-recall-mode.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/direct-turn-recall-mode.ts packages/api/src/orchestrator/direct-turn-recall-mode.test.ts
git commit -m "feat(F042): AC1 三态配置解析器 — off|shadow|inject 缺省 shadow [黄仁勋]"
```

---

## Task 2: AC1 · runThreadTurn 影子拦截 + server 接线

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（三处：类字段 + setter；`runThreadTurn` 召回段 `:1726-1766`；审计调用 `:1802` 附近传 mode）
- Modify: `packages/api/src/server.ts:373-379`（coordinator 构造传 triggerScenarios）+ `:383` 后（messages 注入 mode）
- Test: `packages/api/src/services/message-service.direct-recall.test.ts`（追加用例，沿用现有 fixture）

**Step 1: Write the failing test**（追加到 direct-recall 测试文件，照抄现有 `makeStubDeps`/coordinator fixture 风格）

```typescript
test("F042 AC1 · shadow: direct_turn 召回真跑但 memoryPreflight 不返回", async () => {
  // coordinator 白名单含 direct_turn（resolveTriggerScenarios("shadow")），executor 有命中
  const coord = new AdaptiveRecallCoordinator({
    executor: hitExecutor, // 现有 fixture：返回非空 hits
    enabled: true,
    triggerScenarios: ["wake_up", "a2a_handoff", "direct_turn"],
    defaultBudget: { maxLevels: 5 },
  })
  const r = await resolveDirectTurnRecall(coord, {
    roomId: "R-201", alias: "桂芬", scenario: "direct_turn", query: "F031 现在什么状态",
  })
  assert.equal(r.recallResult?.executed, true, "shadow 下召回链必须真跑")
  assert.ok((r.recallResult?.hits?.length ?? 0) > 0, "命中要保留（供审计）")
  // 影子拦截发生在 runThreadTurn 消费端，本函数照常返回 memoryPreflight —— 见下一用例
})

test("F042 AC1 · off: coordinator 白名单不含 direct_turn → scenario_skip", async () => {
  const coord = new AdaptiveRecallCoordinator({
    executor: hitExecutor,
    enabled: true,
    triggerScenarios: ["wake_up", "a2a_handoff"],
    defaultBudget: { maxLevels: 5 },
  })
  const r = await resolveDirectTurnRecall(coord, {
    roomId: "R-201", alias: "桂芬", scenario: "direct_turn", query: "任意",
  })
  assert.equal(r.recallResult?.executed, false)
  assert.equal(r.recallResult?.reason, "scenario_skip")
})

test("F042 AC1 · applyShadowSuppression: shadow+direct_turn 抹 preflight，wake_up 不受影响", () => {
  const preflight = { hits: [{ path: "wiki/concepts/x.md", score: 0.9 }] }
  assert.equal(applyShadowSuppression("shadow", "direct_turn", preflight), undefined)
  assert.equal(applyShadowSuppression("shadow", "wake_up", preflight), preflight)
  assert.equal(applyShadowSuppression("inject", "direct_turn", preflight), preflight)
  assert.equal(applyShadowSuppression("off", "direct_turn", preflight), preflight) // off 时上游已 skip，这里恒等透传
})
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/api/src/services/message-service.direct-recall.test.ts`
Expected: FAIL — applyShadowSuppression is not exported / triggerScenarios 用例按现状 pass 的保留

**Step 3: Write minimal implementation**

message-service.ts 新增导出（放在 `resolveDirectTurnRecall` 旁）：

```typescript
/**
 * F042 AC1 · 影子拦截：shadow 模式下 direct_turn 的召回结果只进审计不进 prompt。
 * 拆「执行」与「注入」的唯一开关点——wake_up/inject 恒等透传。
 */
export function applyShadowSuppression<T>(
  mode: DirectTurnRecallMode,
  scenario: "wake_up" | "direct_turn",
  memoryPreflight: T | undefined,
): T | undefined {
  if (mode === "shadow" && scenario === "direct_turn") return undefined
  return memoryPreflight
}
```

`runThreadTurn` 召回段（`:1759-1766` 附近）改一行消费：

```typescript
const res = await resolveDirectTurnRecall(this.adaptiveRecallCoordinator, { ... })  // 原样
directRecall = res.recallResult                                                      // 原样
directMemoryPreflight = applyShadowSuppression(
  this.directTurnRecallMode, directRecallScenario, res.memoryPreflight,
)
```

类字段 + setter（对齐 `setPromptAuditWriter` 惯例，`:467` 附近）：

```typescript
private directTurnRecallMode: DirectTurnRecallMode = "shadow"
setDirectTurnRecallMode(mode: DirectTurnRecallMode): void { this.directTurnRecallMode = mode }
```

server.ts 接线（`:373-379` coordinator 构造 + messages 注入）：

```typescript
const directTurnRecallMode = parseDirectTurnRecallMode(process.env.MULTI_AGENT_DIRECT_TURN_RECALL)
const adaptiveRecallCoordinator = new AdaptiveRecallCoordinator({
  ...原有参数,
  triggerScenarios: resolveTriggerScenarios(directTurnRecallMode),
})
messages.setDirectTurnRecallMode(directTurnRecallMode)
logger.info(`[recall] direct_turn mode=${directTurnRecallMode}`)
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/api/src/services/message-service.direct-recall.test.ts packages/api/src/orchestrator/adaptive-recall-coordinator.test.ts`
Expected: PASS（新用例 + 存量全绿）

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/server.ts packages/api/src/services/message-service.direct-recall.test.ts
git commit -m "feat(F042): AC1 direct_turn 影子召回接线 — 白名单扩容+shadow 拦截，默认 shadow [黄仁勋]"
```

**Task 1+2 完成后的 AC1 人工验收（worktree preview）**：起 preview → 网页发普通消息 → 查 worktree DB `SELECT scenario, recall_trigger, recall_results, recall_total_ms FROM prompt_audit ORDER BY id DESC LIMIT 1` 出 direct_turn 行且 `parts_json` 无 recall-pack；`MULTI_AGENT_DIRECT_TURN_RECALL=off` 重启 → 无新行；`=inject` → parts_json 含 recall-pack。三态记录 recall_total_ms 供 D1 复核。

---

## Task 3: AC2 · prompt_audit 扩列 + app_state 表（migration 双镜像）

**Files:**
- Modify: `packages/api/src/db/schema.ts:369-404`（promptAudit 加 3 列 + 新 appState 表）
- Modify: `packages/api/src/db/drizzle-instance.ts`（INIT_SQL 的 prompt_audit 建表语句加列 + `CREATE TABLE IF NOT EXISTS app_state` + MIGRATIONS 数组加 3 条）
- Modify: `packages/api/src/db/sqlite.ts:562` 附近（runAlterMigrations 镜像加同 3 条 + app_state 建表）
- Create: `packages/api/src/db/repositories/app-state-repository.ts`
- Test: `packages/api/src/db/repositories/app-state-repository.test.ts`

新列（全部可空，旧行天然 NULL）：

| 列 | 类型 | 含义 |
|----|------|------|
| `recall_mode` | TEXT | 写入时的三态值（off 不产行；shadow/inject/NULL=legacy） |
| `recall_adopted` | INTEGER | 采纳判定：1/0/NULL=未判（召回空或启发式未跑） |
| `recall_adoption_detail` | TEXT | JSON：`{matches:[{path,term}], checkedAt}` |

MIGRATIONS 三条（命名对齐 `F0XX-<table>-add-<column>` 惯例）：

```typescript
{ name: "F042-prompt_audit-add-recall_mode", sql: "ALTER TABLE prompt_audit ADD COLUMN recall_mode TEXT;" },
{ name: "F042-prompt_audit-add-recall_adopted", sql: "ALTER TABLE prompt_audit ADD COLUMN recall_adopted INTEGER;" },
{ name: "F042-prompt_audit-add-recall_adoption_detail", sql: "ALTER TABLE prompt_audit ADD COLUMN recall_adoption_detail TEXT;" },
```

app_state 表（INIT_SQL + sqlite.ts 两处 `CREATE TABLE IF NOT EXISTS`；新表不需要 ALTER migration）：

```sql
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Step 1: Write the failing test**（app-state-repository.test.ts，用内存/临时 SQLite，复刻 prod 建表——对齐 test-schema-faithful 纪律直接调 `createDrizzleDb` 临时路径）

```typescript
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDrizzleDb } from "../drizzle-instance"
import { AppStateRepository } from "./app-state-repository"

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "f042-appstate-"))
  const { adapter } = createDrizzleDb(path.join(dir, "t.sqlite")) // 按 createDrizzleDb 实际返回结构取原生句柄
  return new AppStateRepository(adapter)
}

test("app_state: get 缺省 null，set 后可读，重复 set 覆盖", () => {
  const repo = makeRepo()
  assert.equal(repo.get("f042_shadow_summary_sent"), null)
  repo.set("f042_shadow_summary_sent", "2026-07-10T00:00:00Z")
  assert.equal(repo.get("f042_shadow_summary_sent"), "2026-07-10T00:00:00Z")
  repo.set("f042_shadow_summary_sent", "v2")
  assert.equal(repo.get("f042_shadow_summary_sent"), "v2")
})

test("prompt_audit 新列存在（migration 双镜像生效）", () => {
  const repo = makeRepo()
  const cols = repo.rawColumns("prompt_audit") // 测试辅助：PRAGMA table_info
  for (const c of ["recall_mode", "recall_adopted", "recall_adoption_detail"]) {
    assert.ok(cols.includes(c), `missing column ${c}`)
  }
})
```

**Step 2: Run** `npx tsx --test packages/api/src/db/repositories/app-state-repository.test.ts` → FAIL（module 不存在）

**Step 3: Implementation**

```typescript
import type { DatabaseSync } from "node:sqlite"

/** F042 D10 · 通用一次性标志/轻量状态 KV。别塞业务大对象——只放标志与游标。 */
export class AppStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
      | { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString())
  }

  rawColumns(table: string): string[] {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.map((r) => r.name)
  }
}
```

（drizzle-instance.ts / sqlite.ts / schema.ts 的三处同步按上表落；`PromptAuditWriter.write` 的 INSERT 列清单 + `PromptAuditInput` 加 `recallMode`，`message-service.ts` 两个审计调用点传 `recallMode: this.directTurnRecallMode`——a2a 路径传 NULL 不填。）

**Step 4: Run** 同上 → PASS；再跑 `npx tsx --test packages/api/src/wiki/prompt-audit/*.test.ts` 确认 writer 存量绿。

**Step 5: Commit**

```bash
git add packages/api/src/db/ packages/api/src/wiki/prompt-audit/
git commit -m "feat(F042): AC2 schema — prompt_audit 采纳三列 + app_state KV（migration 双镜像同步）[黄仁勋]"
```

---

## Task 4: AC2 · 采纳判定启发式（纯函数）

**Files:**
- Create: `packages/api/src/wiki/prompt-audit/adoption-heuristic.ts`
- Test: `packages/api/src/wiki/prompt-audit/adoption-heuristic.test.ts`

**Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict"
import test from "node:test"
import { judgeAdoption } from "./adoption-heuristic"

const hits = [
  { path: "wiki/concepts/F031-WS序列恢复.md", title: "F031-WS序列恢复" },
  { path: "wiki/methods/worktree-预览端口.md", title: "worktree-预览端口" },
]

test("回复引用条目标题 → adopted + 命中路径", () => {
  const r = judgeAdoption("F031-WS序列恢复 已经合并了，seq/epoch 机制见 wiki。", hits)
  assert.equal(r.adopted, true)
  assert.deepEqual(r.matches.map((m) => m.path), ["wiki/concepts/F031-WS序列恢复.md"])
})

test("回复引用 [[wiki-link]] 形态 → adopted", () => {
  const r = judgeAdoption("参考 [[wiki/methods/worktree-预览端口]]。", hits)
  assert.equal(r.adopted, true)
})

test("回复只引用 basename（无目录/扩展名）→ adopted", () => {
  const r = judgeAdoption("看 worktree-预览端口 那篇。", hits)
  assert.equal(r.adopted, true)
})

test("回复与召回无交集 → not adopted", () => {
  const r = judgeAdoption("今天天气不错。", hits)
  assert.equal(r.adopted, false)
  assert.equal(r.matches.length, 0)
})

test("空召回 → null（不可判，勿计入标注）", () => {
  assert.equal(judgeAdoption("任意回复", []), null)
})

test("短英文 title 不误报子串（大小写不敏感但按词边界）", () => {
  const r = judgeAdoption("the api is fine", [{ path: "wiki/concepts/API.md", title: "API" }])
  assert.equal(r?.adopted, true) // 独立词命中
  const r2 = judgeAdoption("rapid response", [{ path: "wiki/concepts/API.md", title: "API" }])
  assert.equal(r2?.adopted, false) // rapid 内的 api 子串不算
})
```

**Step 2: Run** `npx tsx --test packages/api/src/wiki/prompt-audit/adoption-heuristic.test.ts` → FAIL

**Step 3: Implementation**

```typescript
/**
 * F042 AC2 · 采纳判定启发式：回复文本是否引用了召回条目。
 * 三路信号（任一命中即 adopted）：
 *   1. [[wiki-link]] 精确含路径（去 .md 后缀比对）
 *   2. 条目 title 出现在回复里（CJK 直接子串；纯 ASCII 走词边界防 rapid→api 误报）
 *   3. path basename（去 .md）出现在回复里（规则同 2）
 * 返回 null = 召回为空，不可判——调用方不得把 null 计入标注数。
 * 已知边界：启发式只测「提及」不测「因果」；shadow 期它是相关性代理信号，非严格采纳证明。
 */
export interface AdoptionHit { path: string; title: string }
export interface AdoptionVerdict { adopted: boolean; matches: Array<{ path: string; term: string }> }

const CJK_RE = /[一-鿿]/

function termHits(reply: string, term: string): boolean {
  const t = term.trim()
  if (t.length < 2) return false
  if (CJK_RE.test(t)) return reply.includes(t)
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(reply)
}

export function judgeAdoption(reply: string, hits: AdoptionHit[]): AdoptionVerdict | null {
  if (hits.length === 0) return null
  const matches: AdoptionVerdict["matches"] = []
  for (const h of hits) {
    const pathNoExt = h.path.replace(/\.md$/i, "")
    const base = pathNoExt.split("/").pop() ?? ""
    if (reply.includes(`[[${pathNoExt}]]`) || reply.includes(`[[${h.path}]]`)) {
      matches.push({ path: h.path, term: `[[${pathNoExt}]]` })
    } else if (termHits(reply, h.title)) {
      matches.push({ path: h.path, term: h.title })
    } else if (termHits(reply, base)) {
      matches.push({ path: h.path, term: base })
    }
  }
  return { adopted: matches.length > 0, matches }
}
```

**Step 4: Run** 同上 → PASS

**Step 5: Commit**

```bash
git add packages/api/src/wiki/prompt-audit/adoption-heuristic.ts packages/api/src/wiki/prompt-audit/adoption-heuristic.test.ts
git commit -m "feat(F042): AC2 采纳判定启发式 — wiki-link/title/basename 三路，CJK/词边界双制式 [黄仁勋]"
```

---

## Task 5: AC2 · 采纳回写接线 + 统计服务 + 端点

**Files:**
- Modify: `packages/api/src/wiki/prompt-audit/prompt-audit-writer.ts`（`write` 返回 id 已有则复用；新增 `updateAdoption(id, verdict)`）
- Modify: `packages/api/src/services/message-service.ts`（runThreadTurn 中 assistant 回复落库后：取本 turn 审计 row id + recall hits → `judgeAdoption` → fail-soft 回写）
- Create: `packages/api/src/wiki/prompt-audit/recall-stats-service.ts`
- Create: `packages/api/src/routes/phase3/recall-stats.ts`（GET `/api/recall/stats`，query：`window`=行数窗口默认 50、`roomId` 可选）
- Modify: `packages/api/src/routes/phase3/index.ts` + `contracts.ts`（注册 + 参数校验，照抄 prompt-inspector 三段式）
- Test: `packages/api/src/wiki/prompt-audit/recall-stats-service.test.ts`

统计口径（服务返回结构，端点原样出 JSON）：

```typescript
export interface RecallStatsWindow {
  window: number                 // 请求的窗口行数
  totalRecalls: number           // 窗口内 scenario='direct_turn' 且 recall 真跑的行数
  hitRate: number                // recall_results 非空行 / totalRecalls
  adoptionRate: number | null    // recall_adopted=1 / (recall_adopted 非 NULL 行)；分母 0 → null
  annotatedCount: number         // recall_adopted 非 NULL 行数（= D4 定义的「标注」数）
  topEntries: Array<{ path: string; count: number }>  // recall_results JSON 解析聚合 top 10
  oldestAt: string | null
  newestAt: string | null
}
```

SQL 主体（一条窗口查询 + 应用层聚合，对齐 prompt-inspector `LIMIT N` 惯例）：

```sql
SELECT id, created_at, recall_results, recall_adopted
FROM prompt_audit
WHERE scenario = 'direct_turn' AND recall_trigger IS NOT NULL
  AND (? IS NULL OR room_id = ?)
ORDER BY id DESC LIMIT ?
```

**测试要点**（service 测试直连临时 DB 种子行）：种 3 行（2 命中 1 空；命中里 1 adopted）→ hitRate=2/3、adoptionRate=1/2、annotatedCount=2、topEntries 聚合正确；窗口 LIMIT 截断验证；roomId 过滤验证。

**采纳回写接线**（message-service，assistant 落库后、`invocation.finished` 发出前）：

```typescript
// F042 AC2 · fail-soft：判定/回写失败绝不影响 turn 主链
try {
  if (auditRowId != null && directRecall?.hits?.length) {
    const verdict = judgeAdoption(assistantText, directRecall.hits.map(toAdoptionHit))
    if (verdict) this.promptAuditWriter.updateAdoption(auditRowId, verdict)
  }
} catch (err) { this.logger?.warn?.(`[recall] adoption update failed: ${errorMessage(err)}`) }
```

（`writePromptAuditSafe` 现返回值若不含 row id，则给 `PromptAuditWriter.write` 补 `lastInsertRowid` 透出——writer 是唯一 INSERT 收口，改动局部。）

**Commit**

```bash
git add packages/api/src/wiki/prompt-audit/ packages/api/src/routes/phase3/ packages/api/src/services/message-service.ts
git commit -m "feat(F042): AC2 采纳回写 + /api/recall/stats 统计端点（窗口/命中/采纳/Top 条目）[黄仁勋]"
```

---

## Task 6: AC2 · 观察窗满一次性小结卡 + rerank 提示

**Files:**
- Create: `packages/api/src/wiki/prompt-audit/shadow-window-notifier.ts`
- Test: `packages/api/src/wiki/prompt-audit/shadow-window-notifier.test.ts`
- Modify: `packages/api/src/services/message-service.ts`（采纳回写后同一 fail-soft 块内调 `notifier.checkAndNotify(threadId)`）
- Modify: `packages/api/src/server.ts`（构造 notifier：AppStateRepository + RecallStatsService + appendSystemNotice 回调注入）

**行为规格**（D3/D4/D10）：

1. 每次 direct_turn 审计写入后调用 `checkAndNotify(threadId)`。
2. 小结触发条件（先到先触发，app_state `f042_shadow_summary_sent` 为空时）：
   - `annotated ≥ 0 && totalRecalls ≥ 50`，或
   - 最老 direct_turn 召回行距今 ≥ 14 天且 totalRecalls ≥ 1。
3. 触发 → 组装小结文本（命中率/采纳率/Top 5 条目/建议：adoptionRate ≥ 0.6 建议放开 inject，否则建议继续 shadow 并列低分样例）→ `appendSystemNoticeMessage(threadId, content)` + `message.created` emit（复用 F021 seal 链，`message-service.ts:2474-2487` 现场同款）→ `app_state.set("f042_shadow_summary_sent", now)`。
4. rerank 提示（独立标志 `f042_rerank_hint_sent`）：`annotatedCount ≥ 30` → 一次性发「标注攒够，可拍 rerank 立项」通知卡。
5. 两标志置位后永不再发（重置=人工删 app_state 行）。

**测试要点**（stub stats + stub appendNotice 回调）：49 次不发；第 50 次发一次；第 51 次不再发；14 天路径（种老 created_at）发；rerank 提示 30 条阈值独立触发；appendNotice 抛错不炸主链。

**Commit**

```bash
git add packages/api/src/wiki/prompt-audit/shadow-window-notifier.ts packages/api/src/wiki/prompt-audit/shadow-window-notifier.test.ts packages/api/src/services/message-service.ts packages/api/src/server.ts
git commit -m "feat(F042): AC2 影子观察窗一次性小结卡 + rerank 攒够提示（app_state 一次性保证）[黄仁勋]"
```

---

## Task 7: AC3 · 归档路径谓词 + 召回面双点过滤

**Files:**
- Modify: `packages/api/src/wiki/promote-audit/promote-wiki-service.ts`（`isDraftRelativePath` 旁新增导出）
- Modify: `packages/api/src/wiki/wiki-search/wiki-entity-fts-provider.ts:131-133`（draftClause 旁加无条件归档排除）
- Modify: `packages/api/src/wiki/memory-preflight/embedded-records-loader.ts:91`（filter 加谓词）
- Test: `packages/api/src/wiki/wiki-search/wiki-search.test.ts` + `packages/api/src/wiki/memory-preflight/embedded-records-loader.test.ts`（追加用例）

**Step 3 核心代码**：

```typescript
/**
 * F042 AC3 · 召回面归档排除：正式区顶级归档目录（demote → _rejected、supersede → _superseded）
 * 一律不进 search_wiki/preflight/L2/embedded records。与 isDraftRelativePath 同款 normalize
 * 口径（POSIX 折叠 + 小写），两目录一个谓词——_rejected 今天就在索引里可被搜到（2026-07-10
 * 实测 5 行），是与 F031 双胞胎同族的现症，一并收编。
 */
export function isArchivedRelativePath(p: string): boolean {
  const normalized = path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase()
  return normalized.includes("/_superseded/") || normalized.includes("/_rejected/")
}
```

FTS provider（在 draftClause 之后追加**无条件**子句，不受 includeDrafts 影响）：

```typescript
const archiveClause =
  "AND i.path NOT LIKE '%/\\_superseded/%' ESCAPE '\\' AND i.path NOT LIKE '%/\\_rejected/%' ESCAPE '\\'"
```

loader filter：

```typescript
.filter((row) => !isDraftRelativePath(row.path) && !isArchivedRelativePath(row.path))
```

**测试**：FTS——种 `wiki/_superseded/concepts/x.md`、`wiki/_rejected/y.md`、正式区 `wiki/concepts/z.md` 三行 → query 只回 z；includeDrafts=true 时归档仍被排除。loader——同构三行 → records 只含 z。

**Commit**

```bash
git add packages/api/src/wiki/promote-audit/promote-wiki-service.ts packages/api/src/wiki/wiki-search/ packages/api/src/wiki/memory-preflight/
git commit -m "feat(F042): AC3 召回面归档排除 — _superseded/_rejected 双目录单谓词（收编 _rejected 可搜现症）[黄仁勋]"
```

---

## Task 8: AC3 · 同源检测 + supersede 执行器（promote 流程）

**Files:**
- Create: `packages/api/src/wiki/promote-audit/same-source-detector.ts`
- Modify: `packages/api/src/wiki/promote-audit/promote-wiki-service.ts`（promote() dest_exists 检测后插同源检测；新增 supersede 归档执行；`buildSupersededArchivePath`；frontmatter `supersedes` 注入）
- Modify: `packages/api/src/db/repositories/wiki-events-types.ts:15-35`（union 加 `"supersede"`）
- Modify: `packages/api/src/routes/phase4/promote.ts`（409 `SAME_SOURCE_EXISTS` 分支 + 请求体 `supersedePaths?: string[]`）
- Modify: `packages/api/src/routes/phase4/index.ts:40-57`（装配 sameSourceLookup 回调，DB 来自 route deps）
- Test: `packages/api/src/wiki/promote-audit/same-source-detector.test.ts` + promote 服务现有测试文件追加

**same-source-detector**（查 wiki_entity_index 而非 fs walk——promote 频率低、index 有 boot/debounce/5min 三重新鲜度保证；≤5min 双 promote 竞态接受并记录）：

```typescript
/**
 * F042 AC3 · 同源检测：src draft 的 sources[0].path 与正式区已有条目精确匹配 → 撞车。
 * 数据源 = wiki_entity_index.body（含 frontmatter 全文），不走 fs walk。
 * 排除：draft 区、归档区、dest 自身（dest 撞车走既有 dest_exists 通道）。
 */
export interface SameSourceConflict { path: string; title: string }

export function findSameSourceEntries(deps: {
  listIndexedEntries(): Array<{ path: string; name: string; body: string }>
}, srcSourcePath: string, destWikiPath: string): SameSourceConflict[] {
  const out: SameSourceConflict[] = []
  for (const row of deps.listIndexedEntries()) {
    if (row.path === destWikiPath) continue
    if (isDraftRelativePath(row.path) || isArchivedRelativePath(row.path)) continue
    const fm = parseFrontmatter(row.body) // routes/phase3/frontmatter.ts 现成
    const p = sources0Path(fm?.frontmatter) // auto-draft-supersede.ts:160 现成，抽公用或复制引用
    if (p && p === srcSourcePath) out.push({ path: row.path, title: row.name })
  }
  return out
}
```

**promote() 插入点**（`promote-wiki-service.ts:163` dest_exists 检测之后）：

```typescript
// F042 AC3 · 同源撞车强制显式选择（sources[0].path 精确匹配正式区）
const srcSourcePath = sources0Path(parseFrontmatter(srcContent)?.frontmatter)
if (srcSourcePath && this.cfg.sameSourceLookup) {
  const conflicts = findSameSourceEntries(this.cfg.sameSourceLookup, srcSourcePath, req.destWikiPath)
  const unresolved = conflicts.filter((c) => !(req.supersedePaths ?? []).includes(c.path))
  if (unresolved.length > 0) {
    return { status: "same_source_exists", conflicts: unresolved,
      error: `同源条目已在正式区（sources.path=${srcSourcePath}）——须显式选择取代或去合并` }
  }
}
```

**supersede 执行**（dest 写盘成功后、事件 commit 前，逐个 `req.supersedePaths`）：

1. `buildSupersededArchivePath(oldPath)` → `wiki/_superseded/<原相对路径>`（存在则时间戳后缀，镜像 `buildReplacedArchivePath` `:584-592` 写法）
2. `fs.rename` 搬运（同盘同 root，沿用 promote 服务的 safeWikiPath 解析）
3. wiki_events `appendPending({ action: "supersede", path: oldPath, promotionTarget: req.destWikiPath, reason: ... }) → commit`（三段式，`wiki-events-repository.ts:43-104`）
4. destContent 注入 `supersedes: ["<归档后路径>"]`——新 helper `injectSupersedesFrontmatter(content, archivedPaths)`，单行手术对齐 `rewriteCanonicalOwnerPath:563` 风格（已有 supersedes 行则追加数组项；无 frontmatter 不注入 fail-safe）
5. 归档条目退索引依赖 5min 周期 reindex（锚点 6 的第三重）；查询层过滤（Task 7）在 reindex 前已兜底

**route 层**（promote.ts `:244-249` 旁）：

```typescript
case "same_source_exists":
  reply.code(409)
  return { ok: false, code: "SAME_SOURCE_EXISTS", conflicts: result.conflicts, error: result.error }
```

**测试要点**：detector——同源命中/排除 draft/排除归档/排除 dest 自身/无 sources 返回空；promote 集成（临时 wikiRoot）——无 supersedePaths → same_source_exists；带 supersedePaths → 旧条目物理移到 `wiki/_superseded/`、wiki_events 出 supersede 行、dest frontmatter 含 supersedes 指向归档路径；F031 双胞胎重放用例（两版同 sources.path 先后 promote）。

**Commit**

```bash
git add packages/api/src/wiki/promote-audit/ packages/api/src/db/repositories/wiki-events-types.ts packages/api/src/routes/phase4/
git commit -m "feat(F042): AC3 同源撞车强制显式 supersede — 检测/归档执行器/事件账本/409 契约 [黄仁勋]"
```

---

## Task 9: AC3 · NHC 死链扫描排除归档 + 前端同源对比弹窗

**Files:**
- Modify: `packages/api/src/services/scheduler/nightly-health-check.ts:214-238`（deadLinks 循环入口跳过归档来源实体）
- Test: NHC 现有测试文件追加（种 `_superseded` 实体带死链 → 报告 0 条；正式区死链仍报）
- Create: `components/chat/right-panel/runtime-log/promote-modal/same-source-panel.tsx`
- Modify: `components/chat/right-panel/runtime-log/promote-modal/promote-modal.tsx:294-308` 附近（409 SAME_SOURCE_EXISTS → 弹 SameSourcePanel）

**NHC 改动**（(3) 循环入口，注意锚点：噪音源是 `:214` 的通用 deadLinks 循环，不是 `:301` 的 deadSupersedes）：

```typescript
for (const entity of entities) {
  if (isArchivedRelativePath(entity.path)) continue // F042 AC3 · 归档区死链=历史自噪音，非治理信号
  const refs = extractRefs(entity.body, entity.path)
  ...
}
```

（`isSupersededDraftRelativePath` 只认 `draft/_superseded/`——draft 归档；顶级 `wiki/_superseded/` 与 `wiki/_rejected/` 由新谓词覆盖。draft 死链行为不变，超出 spec 不动。）

**SameSourcePanel**（1:1 镜像 `replace-compare-panel.tsx:118-190` 布局与 token，design-taste 对标 DESIGN.md，不引新视觉）：

- 左：正式区旧条目（`GET /api/wiki/page/content?path=<conflict>`）；右：待 promote draft（`GET /api/wiki/drafts/content?path=<src>`）
- 顶部说明：「同源条目已在正式区（sources.path 相同）」+ 双方 mtime
- 按钮两枚：**「取代旧版」**（re-POST promote 带 `supersedePaths:[<conflict>]`）/ **「去合并」**（关弹窗 + 跳转旧条目查看页，D7：机器不合并内容）
- 多条冲突时列表逐条对比（v1 顺序展示，全部选完取代或任一去合并即中止）

**前端验证**：`pnpm build`（或 worktree preview 手点）——promote 一个与正式区同 sources.path 的 draft → 弹窗出现 → 取代 → 旧条目从 search 消失。

**Commit**

```bash
git add packages/api/src/services/scheduler/nightly-health-check.ts components/chat/right-panel/runtime-log/promote-modal/
git commit -m "feat(F042): AC3 NHC 死链排除归档区 + 同源对比弹窗（取代/去合并二选一）[黄仁勋]"
```

---

## Task 10: AC4 · wiki 候选检索适配器 + pre-compile 换喂料

**Files:**
- Create: `packages/api/src/wiki/llm-compile/wiki-candidate-search.ts`
- Modify: `packages/api/src/wiki/llm-compile/pre-compile.ts`（deps 加可选 `wikiCandidateSearch`；有则走它、跳过 message_embeddings 路径；无则现状不变）
- Modify: `packages/api/src/wiki/llm-compile/types.ts`（`SimilarEntity` 加可选 `sourcePath`）
- Test: `packages/api/src/wiki/llm-compile/llm-compile.test.ts` 追加（平铺 test() 风格，mock 检索）

**适配器**（HybridSearchProvider → SimilarEntity；候选自身的 sources[0].path 从 index body 的 frontmatter 提取，供 prompt 同源比对）：

```typescript
/**
 * F042 AC4 · 编译候选检索：生产 hybridWikiSearch（BM25+cosine over wiki_entity_index）
 * 适配成 pre-compile 的 SimilarEntity。替代 message_embeddings 误用（领域错位：
 * embedding-service.ts:255 搜的是聊天消息表，wiki ingest 场景 threadIds 恒空 → 候选恒空）。
 * 查询文本 = title + 正文头 500 字（FTS 查询过长无益，hybrid 内部自带 sanitize）。
 */
export interface WikiCandidateSearch {
  findSimilar(title: string, rawContent: string, topK: number): Promise<SimilarEntity[]>
}

export function createWikiCandidateSearch(deps: {
  hybrid: { search(query: string, opts?: { topK?: number }): Promise<Array<{ path: string; score: number; excerpt: string }>> }
  lookupIndexRow(path: string): { name: string; body: string } | null
}): WikiCandidateSearch {
  return {
    async findSimilar(title, rawContent, topK) {
      const query = `${title} ${rawContent.slice(0, 500)}`.trim()
      const hits = await deps.hybrid.search(query, { topK })
      return hits
        .filter((h) => !isDraftRelativePath(h.path) && !isArchivedRelativePath(h.path))
        .map((h) => {
          const row = deps.lookupIndexRow(h.path)
          const fm = row ? parseFrontmatter(row.body) : null
          return {
            path: h.path,
            title: row?.name ?? h.path,
            summary: h.excerpt.slice(0, 200),
            score: h.score,
            sourcePath: sources0Path(fm?.frontmatter) ?? undefined,
          }
        })
    },
  }
}
```

**pre-compile 改造**（`:76` 守卫处分叉——新路径优先，旧路径原样）：

```typescript
let similarEntities: SimilarEntity[] = []
if (deps.wikiCandidateSearch) {
  // F042 AC4 · wiki_entity_index 真候选（不依赖 threadIds/message_embeddings）
  similarEntities = await deps.wikiCandidateSearch.findSimilar(
    rawMetadata?.title ?? "", rawContent, opts.topK,
  )
} else {
  const rawEmbedding = await deps.embedding.generateEmbedding(rawContent)
  if (rawEmbedding && opts.threadIds.length > 0) { /* 现状路径原封保留 */ }
}
```

**测试**：mock wikiCandidateSearch 返回 2 候选（1 含 sourcePath）→ preCompile 无 threadIds 也产出 similarEntities；无 dep 时存量用例全绿（行为不变）。

**Commit**

```bash
git add packages/api/src/wiki/llm-compile/
git commit -m "feat(F042): AC4 编译候选换喂 wiki_entity_index — hybrid 适配器 + pre-compile 分叉（旧路兜底）[黄仁勋]"
```

---

## Task 11: AC4 · sources.path 进 compile prompt + dedup target 校验 + 生产装配

**Files:**
- Modify: `packages/api/src/wiki/llm-compile/compile-prompt.ts`（`BuildCompileLLMInput` 加 `sources?`；`formatPreCompileContext` 渲染候选 sourcePath；新增本次收录来源段）
- Modify: `packages/api/src/wiki/llm-compile/compile-pipeline.ts:81-84`（buildCompileLLMSystemPrompt 传 `input.agentDraft.sources`；preCompile deps 传 `input.deps.wikiCandidateSearch`）
- Modify: `packages/api/src/wiki/llm-compile/post-compile.ts:90-103`（dedup target 存在性校验，镜像 `:43-58` deadRefs 先例）
- Modify: `packages/api/src/server.ts:1018-1038`（compile deps 装配注入 `wikiCandidateSearch: createWikiCandidateSearch({ hybrid: hybridWikiSearch, lookupIndexRow })`——`hybridWikiSearch` `:360` 已在作用域）
- Test: `llm-compile.test.ts` 追加端到端用例

**prompt 增段**（formatPreCompileContext 内）：

```typescript
if (ctx.similarEntities.length > 0) {
  lines.push("Wiki 已有以下相关 entity（top-k 相似，按 similarity 排序）：")
  for (const ent of ctx.similarEntities) {
    const src = ent.sourcePath ? ` [来源: ${ent.sourcePath}]` : ""
    lines.push(`- [[${ent.path}]] (sim ${ent.score.toFixed(2)})${src} — ${truncate(ent.summary, 120)}`)
  }
}
// 新增段（sources 由 BuildCompileLLMInput 传入）：
if (input.sources?.[0]?.path) {
  lines.push("", `【本次收录来源】${input.sources[0].path}`,
    "若上方候选中存在相同来源的条目，即为同一文档的旧版本——dedup 判定必须给出 supersedes 或 merge_into（禁止 new_entity），target 用该候选的 [[path]]。")
}
```

**dedup target 校验**（post-compile，落 frontmatter 前）：

```typescript
// F042 AC4 · target 存在性校验（镜像 cross_refs deadRefs 先例）：LLM 编造的 target 不落盘
if (verdict === "merge_into" || verdict === "supersedes") {
  const target = llmOutput.dedup_decision.target_entity
  if (target && !(await deps.entityChecker.exists(target))) {
    warnings.push({ kind: "dead_dedup_target", target })
    llmOutput.dedup_decision = { verdict: "new_entity", target_entity: null } // 降级 fail-safe
  }
}
```

**端到端用例**（fixture LLM）：候选含同 sourcePath 条目 + fixture 返回 `supersedes` → `result.dedupDecision.verdict === "supersedes"` 且 `frontmatter.supersedes` 指向真实候选路径；fixture 返回编造 target → 降级 new_entity + warning；prompt 文本断言含「本次收录来源」与「[来源: 」两段。

**Commit**

```bash
git add packages/api/src/wiki/llm-compile/ packages/api/src/server.ts
git commit -m "feat(F042): AC4 sources.path 进 compile prompt + dedup target 存在性校验 + 生产装配 hybrid 喂料 [黄仁勋]"
```

**AC4 人工验收（worktree preview）**：收录一篇与正式区已有条目同 sourcePath 的文档 → preview 编译产物 dedup verdict = supersedes/merge_into 且 target 正确；相关主题另一篇 → cross_refs 非空。

---

## Task 12: AC5 · 外部守活探针脚本

**Files:**
- Create: `scripts/health-probe.ps1`
- Modify: `docs/features/F042-memory-consumption-loop.md`（Links 下补安装说明段）

**脚本规格**（单次探测设计，由 Windows 任务计划每 15-30min 拉起；PS 5.1 兼容，零模块依赖）：

```powershell
<#
F042 AC5 · 进程外守活探针（单发）。
安装（管理员不需要，当前用户即可）：
  schtasks /create /tn "MultiAgent-HealthProbe" /sc minute /mo 20 ^
    /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\-\Desktop\Multi-Agent\scripts\health-probe.ps1"
卸载：schtasks /delete /tn "MultiAgent-HealthProbe" /f
维护模式（手动停用不误报）：health-probe.ps1 -SetMaintenance on|off
#>
param(
  [string]$ApiUrl = "http://localhost:8787/health",
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$SetMaintenance = ""
)
$flagPath = Join-Path $RepoRoot ".runtime\maintenance.flag"
$logPath  = Join-Path $RepoRoot ".runtime\health-probe.log"

if ($SetMaintenance -eq "on")  { "manual stop $(Get-Date -Format o)" | Out-File $flagPath -Encoding utf8; exit 0 }
if ($SetMaintenance -eq "off") { if (Test-Path $flagPath) { Remove-Item $flagPath -Force -Confirm:$false }; exit 0 }
if (Test-Path $flagPath) { exit 0 }  # 维护模式：静默

$ok = $false
try {
  $resp = Invoke-WebRequest -Uri $ApiUrl -UseBasicParsing -TimeoutSec 5
  $ok = ($resp.StatusCode -eq 200)
} catch { $ok = $false }

$stamp = Get-Date -Format o
if ($ok) { Add-Content $logPath "$stamp OK"; exit 0 }

Add-Content $logPath "$stamp FAIL $ApiUrl"
# WinRT toast（PS5.1 原生，无模块）；toast 失败退化为 msg 弹窗
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $xml.GetElementsByTagName("text").Item(0).InnerText = "Multi-Agent API 探活失败"
  $xml.GetElementsByTagName("text").Item(1).InnerText = "$ApiUrl 无响应（$stamp）。若是手动停用，请跑 health-probe.ps1 -SetMaintenance on"
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Multi-Agent 守活").Show(
    [Windows.UI.Notifications.ToastNotification]::new($xml))
} catch { try { msg * "Multi-Agent API 探活失败: $ApiUrl" } catch {} }
exit 1
```

**验证步骤（手动，写进 PR 描述）**：
1. worktree preview API 起着 → `powershell -File scripts/health-probe.ps1 -ApiUrl http://localhost:88XX/health` → exit 0，log 出 OK 行
2. 杀 preview API → 再跑 → toast 弹出 + log FAIL 行 + exit 1
3. `-SetMaintenance on` → 再跑 → 静默 exit 0；`off` 恢复报警
4. schtasks 安装/卸载各跑一遍确认注册成功（装完即卸，正式安装留小孙重启主仓时做）

**Commit**

```bash
git add scripts/health-probe.ps1 docs/features/F042-memory-consumption-loop.md
git commit -m "feat(F042): AC5 外部守活探针 — schtasks 单发探测 + 维护模式 + toast 报警 [黄仁勋]"
```

---

## Task 13: 全量回归 + quality-gate

1. `pnpm run test:api`（全量，含存量）→ 全绿
2. `pnpm build`（web + api）→ 过
3. worktree preview 全链人工验收：AC1 三态 / AC2 统计端点 + 模拟窗口满（临时把阈值 env 调低或直接种 50 行）小结卡真发出 / AC3 F031 双胞胎重放 / AC4 同源收录重放 / AC5 杀活探测
4. 走 `quality-gate` skill → `acceptance-guardian` → @范德彪 真 Codex review → merge-gate

## 风险与回滚

- **默认 shadow 上线即改变每条消息的执行路径**（多一次召回链 await）：`recall_total_ms` 全程记录，p95 异常另拆异步（D1 预案）；极端情况 `.env` 设 `MULTI_AGENT_DIRECT_TURN_RECALL=off` 一键回到 F027 现状（小孙操作，Iron Law 3）。
- **migration 双镜像漏一处**：Task 3 测试用 `createDrizzleDb` 真建表验列，漏镜像会在测试期炸，不会带病合入。
- **FTS 归档过滤误伤**：若存在依赖搜索 `_rejected` 的隐藏消费面（未发现 caller），worktree 全量测试 + preview 手测兜底；真有则给 FTS 加显式 `includeArchived` 选项而非回滚谓词。
