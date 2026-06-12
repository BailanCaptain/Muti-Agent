# F029 调研与核查管道 Implementation Plan

**Feature:** F029 — `docs/features/F029-research-verification-pipeline.md`（设计审五轮收敛，德彪终审 GO d90b8f5）
**Goal:** runtime 落一条调研与核查管道：统一检索层 + 异质 agent 独立取证 + 结构化证据账本 + fail-closed 裁决——一个中性底座、两个 projection（fact-check 判真假 / deep-research 深搜综述），主入口为房间顶部搜索条，结果以报告卡进对话流。
**Architecture:** 新建 `packages/api/src/research/` 域模块（与 `wiki/` 平级，命名隔离）：中性领域模型 6 表落 SQLite（sqlite.ts + schema.ts 双定义惯例）+ durable case 状态机（CAS 转移，幂等 task key）+ safe-fetch（SSRF guard + redirect 链审计）+ 类型化只读执行器（search/fetchPublicResult 唯二入口）+ 确定性 extractor（UNTRUSTED_CONTENT 隔离）。benchmark 统计契约（Wilson/ECE 固定参数）先行落为纯函数。前端搜索条 → REST 建 case → WS 渐进事件 → BlockRenderer 新 `report` block。
**Tech Stack:** drizzle-orm(sqlite) / node:test(api) + vitest(components) / undici fetch / playwright（仅 0B）/ croner（复用 scheduler-bootstrap）

## AC 覆盖映射（全量；AC 原文以 feature doc 为唯一真相源，此处只做 ID→Task 溯源）

| AC | 一句话 | Task | 批次 |
|----|--------|------|------|
| AC-P0a-1 信源矩阵实测 | 30+ 平台可达扫描→前 8-12 深测 | T0a-3 | ⛔ 需 API key（小孙） |
| AC-P0a-2 gold set ≥300 | 7:3 冻结 + n≥189 规划 | T0a-2(schema/工具) + 人工标注 | 🟡 schema 今夜可建 |
| AC-P0a-3 provider smoke | train-only 选型 | T0a-3 | ⛔ 需 API key |
| AC-P0a-4 路由表+白名单 | 声明类型→渠道 v1 | T0a-4 | 🟢 文档+代码常量可先行 |
| AC-P0a-5 平台合规登记 | ToS/账号风险 | T0a-4 | 🟢 模板可先行 |
| AC-P0b-1..5 登录态 spike | AuthenticatedBrowserService 全套 | T0b-1..3 | ⛔ 需小孙小号；lease/FIFO 机械层可单测先行 |
| AC-P1a-1 中性底座 | 6 实体域模型 | **T1a-1/2/3** | 🟢 今夜 |
| AC-P1a-2 durable 状态机 | CAS + 幂等 + 断点 | **T1a-4** | 🟢 今夜 |
| AC-P1a-3 Phase A 真隔离 | neutral brief + sibling-canary | **T1a-7 + T1b-4**（双件齐才关闭：fake 契约今夜，真 adapter 集成 canary 归 1b） | 🟡 跨批次 |
| AC-P1a-4 SSRF | url-guard 全规则 | **T1a-5** | 🟢 今夜 |
| AC-P1a-5 防注入 | extractor + corpus | **T1a-8** | 🟢 今夜（corpus 首版） |
| AC-P1a-6 只读执行器 | 类型化唯二入口 | **T1a-6** | 🟢 今夜 |
| AC-P1a-7 证据可复现 | 快照+谱系+降级语义 | **T1a-9** | 🟢 今夜 |
| AC-P1b-1..10 检索/裁决/质量 | 拆解/eligibility/provider/quorum/entailment/纪律/门槛/档位 | T1b-1..8 | Phase 1b 启动时细化 |
| AC-P1c-1..7 渠道/UI/入口/边界 | 搜索条/报告卡/外发 allowlist/walking skeleton | T1c-1..7 | Phase 1c 启动时细化 |
| AC-P2-1..4 deep-research | 维度拆解/覆盖检索/综合报告/contract test | T2-1..4 | Phase 2 启动时细化 |

> **统计契约前置**：AC-P1b-9 的 Wilson/ECE 数学（n≥73/n≥189、conf_bin 0.6/0.8/0.95）作为 **T1a-0 纯函数先行**——它是 P5 五轮 review 的核心战果，落成代码防漂移，0A 标注工具与 1b 验收共用。

## 既定边界（不做什么）

- 预测市场 / 传播图 / 图像视频鉴伪 / 意图自动判断 / 抖音 / 消息右键入口（Phase 2 再议）/ 主号登录
- Phase 1 一切用户入口禁跑 deep-research（仅内部 fixture）
- `.env` 加 API key、注册平台小号 = **小孙人工操作**（Iron Law §3），代码只读 `process.env`，缺 key 时 provider 报 `not-configured` 降级
- 通宵首战（2026-06-13 夜）只全速推 **Phase 1a + T1a-0**；0A 可先行件（schema/路由表/合规模板）时间允许才做

## 实测过的代码锚点（2026-06-13 dev HEAD 2bee192 实测）

- **表定义三源（德彪 plan review P1 纠正，2026-06-13 实测核实）**：生产 boot `server.ts:118 createDrizzleDb()` 先执行 `db/drizzle-instance.ts:91 INIT_SQL`（真正的首跑 DDL），`db/sqlite.ts`（legacy SqliteStore CREATE TABLE）与 `db/schema.ts`（drizzle 定义）随后。**新表必须三处同步**：drizzle-instance.ts INIT_SQL + sqlite.ts + schema.ts；parity 测试仿 `drizzle-instance.test.ts:463,494`（真实 SQLite 表/索引断言，两条启动路径分别验证），不能只靠 schema.test.ts（它只查导出）
- repo 惯例：`packages/api/src/db/repositories/wiki-leases-repository.ts`（interface+impl+types+test 四件套；CAS 用 `UPDATE ... WHERE` 受影响行数判定）
- 域模块惯例：`packages/api/src/wiki/`（子模块目录 + 测试同置）；F029 落 `packages/api/src/research/`
- scheduler：`packages/api/src/services/scheduler/nightly-job-scheduler.ts` + `packages/api/src/runtime/scheduler-bootstrap.ts`（croner）
- ToolEvent 无审计字段确认：`packages/shared/src/tool-event.ts:1-11`
- port-validator 是"仅允许 loopback"（preview 用），与 F029 url-guard（拒绝 loopback/私网）方向相反，**不复用、不冲突**：`packages/api/src/preview/port-validator.ts:8`
- api 测试跑法：`tsx --test packages/**/*.test.ts`（node:test + assert/strict）

---

# Phase 1a 任务（今夜批次，TDD 全粒度）

## Task 1a-0: benchmark 统计契约纯函数（Wilson + ECE 固定参数）

**Files:**
- Create: `packages/api/src/research/benchmark/stats.ts`
- Test: `packages/api/src/research/benchmark/stats.test.ts`

**Step 1 写失败测试**（关键用例，全部来自 AC-P1b-9 冻结数字）：

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { wilson95, ece, CONF_BIN, type EceSample } from "./stats"

describe("wilson95", () => {
  it("零错误 n=73 上界 ≤5%（AC-P1b-9 样本规划下限）", () => {
    const { upper } = wilson95(0, 73)
    assert.ok(upper <= 0.05, `expected ≤0.05, got ${upper}`)
  })
  it("零错误 n=72 上界 >5%（73 是精确下限）", () => {
    assert.ok(wilson95(0, 72).upper > 0.05)
  })
  it("零错误 n=189 上界 ≤2%；n=188 >2%（z²/(n+z²) 精确解）", () => {
    assert.ok(wilson95(0, 189).upper <= 0.02)
    assert.ok(wilson95(0, 188).upper > 0.02)
  })
  it("零错误 n=150 上界 ≈2.5%（德彪 P5 反例回归钉）", () => {
    const { upper } = wilson95(0, 150)
    assert.ok(upper > 0.02 && upper < 0.026)
  })
  it("下界：85% 点估计样本不足时下界 <85%（达标看界不看点）", () => {
    assert.ok(wilson95(17, 20).lower < 0.85)
  })
  it("n=0 抛错（分母为零不允许静默）", () => {
    assert.throws(() => wilson95(0, 0))
  })
})

describe("ece（conf_bin 冻结 low=0.6/med=0.8/high=0.95）", () => {
  it("CONF_BIN 常量与 AC-P1b-9 一致（预注册冻结，改动即 review 事件）", () => {
    assert.deepEqual(CONF_BIN, { low: 0.6, med: 0.8, high: 0.95 })
  })
  it("acc_bin 恰等 conf_bin → ECE=0", () => {
    const s: EceSample[] = [
      ...mk("low", 6, 4), ...mk("med", 8, 2), ...mk("high", 19, 1),
    ]
    assert.ok(ece(s) < 1e-9)
  })
  it("high 档全错 → ECE 按 |0−0.95| 权重计入且 >0.1", () => {
    const s: EceSample[] = [...mk("high", 0, 10)]
    assert.ok(Math.abs(ece(s) - 0.95) < 1e-9)
  })
  it("空样本抛错", () => { assert.throws(() => ece([])) })
})

function mk(band: "low" | "med" | "high", correct: number, wrong: number): EceSample[] {
  return [
    ...Array.from({ length: correct }, () => ({ band, correct: true })),
    ...Array.from({ length: wrong }, () => ({ band, correct: false })),
  ]
}
```

**Step 2** Run: `npx tsx --test packages/api/src/research/benchmark/stats.test.ts` → FAIL（模块不存在）
**Step 3 最小实现**：

```typescript
// Wilson score interval (z=1.959963984540054, 95%)：
// center=(p̂+z²/2n)/(1+z²/n)，half=z·√(p̂(1−p̂)/n+z²/4n²)/(1+z²/n)
// AC-P1b-9 契约：达标判定一律用区间界（lower 对"≥阈值"类、upper 对"错误率≤阈值"类），非点估计。
const Z = 1.959963984540054

export function wilson95(successes: number, n: number): { lower: number; upper: number; point: number } {
  if (n <= 0) throw new Error("wilson95: n must be > 0")
  if (successes < 0 || successes > n) throw new Error("wilson95: successes out of range")
  const p = successes / n
  const z2 = Z * Z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half), point: p }
}

// AC-P1b-9 预注册冻结：改此常量 = 改验收契约，必须走 feature doc 修订 + review
export const CONF_BIN = { low: 0.6, med: 0.8, high: 0.95 } as const
export type ConfidenceBand = keyof typeof CONF_BIN
export type EceSample = { band: ConfidenceBand; correct: boolean }

export function ece(samples: readonly EceSample[]): number {
  if (samples.length === 0) throw new Error("ece: empty sample set")
  let sum = 0
  for (const band of Object.keys(CONF_BIN) as ConfidenceBand[]) {
    const bin = samples.filter((s) => s.band === band)
    if (bin.length === 0) continue
    const acc = bin.filter((s) => s.correct).length / bin.length
    sum += (bin.length / samples.length) * Math.abs(acc - CONF_BIN[band])
  }
  return sum
}
```

**Step 4** Run 同命令 → PASS（注意：`wilson95(0,73).upper≤0.05` 与 `(0,189).upper≤0.02` 若 FAIL，说明 73/189 边界断言与公式实现有出入——**以公式为准实测修正 AC 数字并升级 review，禁拍脑袋改测试**）
**Step 5** Commit: `feat(F029): T1a-0 benchmark 统计契约 — Wilson95 区间 + ECE 固定 conf_bin 纯函数 [黄仁勋]`

## Task 1a-1: 共享领域类型（packages/shared）

**Files:**
- Create: `packages/shared/src/research.ts`；Modify: `packages/shared/src/index.ts`（export）
- Test: `packages/api/src/research/__tests__/research-types.test.ts`（类型 + 守卫函数行为）

核心契约（终态形状，后续只扩展不重写）：

```typescript
export type ResearchMode = "fact-check" | "deep-research"
export type ResearchCaseState =
  | "created" | "decomposing" | "retrieving" | "assessing" | "reporting"
  | "done" | "partial" | "failed" | "cancelled"
export type ClaimRelation = "supported" | "contradicted" | "mixed" | "insufficient"
export type ConfidenceBand = "low" | "med" | "high"   // 数值代表值见 benchmark/stats CONF_BIN
export type ContextFlag = "misleading-context" | "outdated" | "cherry-picked"
export type FabricationFlag = "not-assessed" | "evidenced"
export type EvidenceReproducibility = "reproducible" | "snapshot-missing"  // 降级语义 AC-P1a-7

export type Verdict = {
  claimRelation: ClaimRelation
  confidence: ConfidenceBand
  contextFlags: ContextFlag[]
  fabrication: FabricationFlag
}
// + ResearchCase / QuestionUnit / RetrievalPlan / EvidenceItem / Assessment / ReportProjection
//   字段以 Task 1a-2 表结构为准（id/caseId/状态/预算/task_key/时间戳/来源谱系）
```

**类型单一真相源（德彪 plan review 纠正）**：六实体字段在本任务的 `packages/shared/src/research.ts` 一次性冻结（不再"以 T1a-2 表结构为准"）；T1a-2 表结构映射 shared 类型，T1a-3 repo 文件**不得**另建实体类型（`research-types.ts` 只放 repo 输入输出包装/row mapper，实体 import 自 shared）。
TDD 步骤同模板：守卫函数（`isTerminalState`、`VALID_TRANSITIONS` 表导出）失败测试 → 实现 → commit `feat(F029): T1a-1 中性领域模型共享类型`。

## Task 1a-2: 七表落库（**三源同步**：drizzle-instance INIT_SQL + sqlite.ts + schema.ts）

**Files:**
- Modify: `packages/api/src/db/drizzle-instance.ts`（INIT_SQL 加 7×CREATE TABLE IF NOT EXISTS + 索引——生产首跑 DDL，缺它独立 Drizzle 启动/测试缺表）
- Modify: `packages/api/src/db/sqlite.ts`（legacy 路径同步）
- Modify: `packages/api/src/db/schema.ts`（drizzle 定义）
- Test: `packages/api/src/db/drizzle-instance.test.ts` 模式新增 research 表 parity 断言（真实 SQLite `sqlite_master` 表+索引检查，**两条启动路径分别验证**）；schema.test.ts 补导出检查

表：`research_cases`（state/mode/claim_frozen/budget_tier/task_key UNIQUE 幂等/retry_count/cancelled_reason/timestamps）、`research_question_units`、`research_retrieval_plans`、`research_evidence_items`（final_url/redirect_chain JSON/http_status/fetched_at/snapshot_path/snapshot_hash/extractor_version/extract_rule_id/excerpt/excerpt_hash/reproducibility/origin_domain/provider_id/untrusted=1 固定）、`research_assessments`（verdict 四字段 + evidence_span 绑定 + reasoning + agent_id + phase a/b）、`research_report_projections`（mode/payload JSON/version）。
外发账本 `research_outbound_log`（case_id/provider_id/fields_sent JSON/sent_at）也在本任务建表（AC-P1c-3 的存储依赖，写入逻辑归 1c）。
步骤：先写 schema.test.ts 断言（FAIL）→ 两处加表 → PASS → commit `feat(F029): T1a-2 research 六表+外发账本落库`。

## Task 1a-3: ResearchCaseRepository + EvidenceRepository

**Files:**
- Create: `packages/api/src/db/repositories/research-case-repository.ts` + `.test.ts` + `research-types.ts`
- Create: `packages/api/src/db/repositories/research-evidence-repository.ts` + `.test.ts`
- Modify: `packages/api/src/db/repositories/index.ts`

仿 `wiki-leases-repository` 四件套，**实体类型一律 import 自 shared/research.ts（repo 文件只放 row mapper，禁第二真相源）**。CaseRepo：`createCase(task_key 幂等——重复 key 返回既有 case 不重建)/getCase/listByState/transitionState(CAS: UPDATE..WHERE state=expected，返回 boolean)/recordRetry/markCancelled` + **QuestionUnit/RetrievalPlan 持久化 API**（`appendQuestionUnits/listQuestionUnits/upsertRetrievalPlan/getRetrievalPlan`——德彪 review 补）。EvidenceRepo：`appendEvidence/listByCase/appendAssessment/listAssessments/upsertProjection`。
测试钉死：幂等重入、CAS 抢占失败返回 false 不抛、terminal 态拒绝再转移、evidence JSON roundtrip、question-unit/plan roundtrip。
Commit: `feat(F029): T1a-3 case/evidence repository（CAS 转移 + task_key 幂等）`

## Task 1a-4: durable case 状态机服务（AC-P1a-2）

**Files:**
- Create: `packages/api/src/research/case-state-machine.ts` + `.test.ts`

`VALID_TRANSITIONS`（shared 导出）驱动：created→decomposing→retrieving→assessing→reporting→done；任意非 terminal→failed/cancelled；retrieving/assessing 超预算→**partial 为显式合法转移**（部分报告语义，含 partial_reason 落库）。`advance(caseId, from, to)` 走 repo CAS；`resume(caseId)` 按当前 state 返回下一步动作描述（断点恢复，不依赖 worklist 自由文本）。**provider retry policy**（AC-P1a-2 显式要求，德彪 review 补）：per-provider `maxAttempts/backoffMs/retryable 错误分类`落 case 级配置字段，`recordRetry` 超限→该 provider 标 exhausted 进 degradation 记录，不死循环。budget 字段递减接口 + 超时标记。全部 fake-clock 单测。
Commit: `feat(F029): T1a-4 durable case 状态机（CAS 转移+断点恢复+预算）`

## Task 1a-5: SSRF url-guard + safe-fetch（AC-P1a-4）

**Files:**
- Create: `packages/api/src/research/safe-fetch/url-guard.ts` + `.test.ts`
- Create: `packages/api/src/research/safe-fetch/safe-fetch.ts` + `.test.ts`

url-guard 拒绝：非 http/https（file:/ftp:/data:…）、loopback（127/8、::1、localhost）、私网（10/8、172.16/12、192.168/16、169.254/16 link-local、fc00::/7、fe80::/10）、`0.0.0.0`、IP 字面量十进制/八进制混淆（`2130706433`、`017700000001`）。**DNS rebinding**：resolve 后对解析出的每个 IP 复检私网规则，连接 pin 到已校验 IP（undici connect.lookup 注入）。**redirect 逃逸**：safe-fetch 手动跟随（redirect:"manual"），每跳 Location 重过 url-guard，记录完整 redirect_chain；超 5 跳拒绝。响应捕获 final_url/status/headers 时间戳——直接产出 AC-P1a-7 要的谱系字段。
**测试网络纪律（德彪 review）**：fake DNS/30x 链一律走**注入 lookup 函数 + 注入 undici dispatcher/MockAgent**，**禁止 bind 真实 localhost 端口**（Iron Law §4：测试也不许碰不属于本服务的端口面）；不打真网。
Commit: `feat(F029): T1a-5 SSRF url-guard + safe-fetch（DNS pin + redirect 链审计）`

## Task 1a-6: 类型化只读执行器（AC-P1a-6）

**Files:**
- Create: `packages/api/src/research/providers/search-provider.ts`（接口）+ `provider-registry.ts` + `.test.ts`
- Create: `packages/api/src/research/providers/fixture-provider.ts`（walking-skeleton/测试用确定性 provider）

`SearchProvider`：`id/kind(api|web-public|authed|factcheck-org)/search(query,opts)→SearchResultRef[]` + `fetchPublicResult(ref)→RawFetchResult`。**registry 返回冻结窄 facade**（`Object.freeze`，只含 search/fetchPublicResult 两方法，调用方拿不到 provider 实例本体——德彪 review：导出面检查不够，需运行时窄化）；**恶意 provider 测试**：注册一个企图暴露 `goto/click/evaluate/post/upload` 方法与任意 fetch 的 provider，断言 facade 上这些能力全部不可达、其内部 fetch 仍被强制路由 safe-fetch。fetchPublicResult 内部强制走 safe-fetch + 仅 GET（非 GET 抛 `ReadOnlyViolation`，自动测试钉死）。缺 `.env` key 的 provider 注册为 `not-configured`，调用报降级错误不崩 case（0A 解锁后即插）。
Commit: `feat(F029): T1a-6 类型化只读执行器（唯二操作+GET-only+导出面测试）`

## Task 1a-7: neutral brief + Phase A 隔离会话 + sibling-canary（AC-P1a-3）

**Files:**
- Create: `packages/api/src/research/verification/neutral-brief.ts` + `.test.ts`
- Create: `packages/api/src/research/verification/verifier-session.ts` + `.test.ts`

neutral-brief：从 ResearchCase 构造与 agent 无关的 brief（冻结声明/原子 claims/检索纪律/输出 schema），`briefHash = sha256(canonical-json)`——所有验证者收到 hash 相同的同一份。verifier-session：每验证者一次性独立 invocation 上下文（**不注入房间历史**，构造参数里根本没有 room/thread 字段——结构性隔离而非过滤），收 brief 出结构化结果。**sibling-canary 测试**：给 fake-runtime A 的环境塞 canary 串，断言 B 的输入/输出全程不含 canary；任何出现即 fail。
**验收口径（德彪 review 纠正）**：本任务只钉单元契约，**不独立关闭 AC-P1a-3**——真 codex/gemini adapter 接线 + 真 adapter 上的 sibling-canary 集成测试归 T1b-4，AC-P1a-3 在 T1a-7+T1b-4 双件齐后才打勾（AC 映射表已同步）。
Commit: `feat(F029): T1a-7 neutral brief + 隔离 verifier session + sibling-canary`

## Task 1a-8: 确定性 extractor + 注入 corpus（AC-P1a-5）

**Files:**
- Create: `packages/api/src/research/evidence/evidence-extractor.ts` + `.test.ts`
- Create: `packages/api/src/research/evidence/injection-corpus.test.ts` + `fixtures/injection-corpus/*.html`（≥10 样本：指令注入/工具调用诱导/泄 prompt 诱导/改 schema 诱导/新域访问诱导/unicode 混淆）

extractor：HTML→`EvidenceDocument{text, title, publishedAt?, extractorVersion, extractRuleId}`，纯函数确定性（同输入同输出），**绝不**把 script/style/事件属性/原始 HTML 带入 text；输出统一打 `UNTRUSTED_CONTENT` 包络。
**corpus 断言必须是行为级，不是包装级（德彪 review 纠正）**：对每个恶意样本走"extract→record→brief 构造→输出 schema 校验"的真实管线后断言——①brief instruction 段 hash 不随 evidence 内容变化（注入文本进不了指令位）②伪造"工具调用/改检索计划/访问新域"形状的输出被 verdict schema 校验**拒绝**（fail-closed，附带哪条规则拒的）③url-guard 对同一 URL 的判定与 evidence 内容零相关（行为不可被内容改写）④cookie/secret 形状串经管线后不出现在任何持久化/外发字段。1a 管线内可达的行为全测；需要真 LLM 的端到端注入演练归 1b benchmark runner 附带项。
Commit: `feat(F029): T1a-8 确定性 extractor + prompt-injection corpus 首版`

## Task 1a-9: 证据记录器——快照+谱系+降级（AC-P1a-7）

**Files:**
- Create: `packages/api/src/research/evidence/evidence-recorder.ts` + `.test.ts`

safe-fetch 结果 + extractor 输出 → EvidenceItem 持久化：**规范化快照定义冻结**（德彪 review 补）：存 extractor 归一后的 canonical 形态（UTF-8、剥 script/style/事件属性、属性排序稳定），同输入 bytes→同快照 hash；原始 bytes 不落盘（版权+注入面双收敛）。快照写 `.runtime/research/snapshots/<caseId>/<hash>.html`（**不在 `.runtime/uploads` 静态暴露路径**；caseId/hash 均服务端生成，路径不接受外部输入拼接），DB 存 path+hash；快照写失败 → `reproducibility="snapshot-missing"` 降级为线索并存 failure 原因（**显式降级，不假成功**）。excerpt+hash、extractor 版本、rule id 全链入库。temp-dir 单测含磁盘写失败注入。
Commit: `feat(F029): T1a-9 evidence recorder（快照谱系+snapshot-missing 降级）`

## Task 1a-10: Phase 1a 收尾——boot 接线 + quality-gate

**Files:**
- Modify: `packages/api/src/index.ts` 或 `server.ts`（research 模块初始化：repo 实例化 + 状态机服务挂载；无路由/无 UI——入口归 1c）
- 全量:`pnpm typecheck && pnpm test`

boot 接线有单测（[Codex Judge2] 教训：unit test 绿 ≠ boot wire 上）。跑 quality-gate skill 自检 → evidence pack（AC-P1a-1..7 逐条命令+输出）→ 派德彪 code review（worktree HEAD hash）→ receiving-review 修到 GO。**不合 dev**——Phase 级 commit 留 worktree，待小孙 Phase 1a 验收（[Feature Completion Before Merge]）。

---

# Phase 0A 先行件（今夜时间允许才做，不阻塞 1a）

- **T0a-2a** gold-set schema + 标注工具骨架：`packages/api/src/research/benchmark/gold-set.ts`（条目 schema：claim/真值/时间截点/预期主来源/声明类型/语言/难度/train|holdout 分层字段）+ 分层抽样校验函数（每层 ≥20 断言）+ tag 冻结校验（holdout 封存=文件 hash 锁）。复用 T1a-0 stats。
- **T0a-4** 路由表 v1 常量 + 核查机构白名单 ≥5 家 + 合规登记模板（`docs/features/F029-*` 附属或 `packages/api/src/research/routing/route-table.ts`）。
- ⛔ T0a-1/T0a-3（真实测扫描/smoke）等小孙 `.env` 加 key 后开工。

# Phase 0B / 1b / 1c / 2 任务地图（phase 启动时按 1a 粒度细化，此处定边界与文件落点）

- **0B**（⛔ 小号）：T0b-1 AuthenticatedBrowserService（`packages/api/src/research/authed-browser/`，launchPersistentContext headed；lease/FIFO 复用 wiki-leases CAS 模式可先单测）；T0b-2 login-session REST+WS 状态机；T0b-3 雪球 pilot（验收用例=登录后才新增的能力）。
- **1b**：T1b-1 claim 拆解+冻结（LLM 调用走现有 runtime）；T1b-2 eligibility 分类；T1b-3 ≥2 外部 provider 实装（接 T1a-6 registry）；T1b-4 verifier-session 接真 codex/gemini CLI（隔离已被 T1a-7 钉死）；T1b-5 quorum 判定器（异质≥2 且来源独立）；T1b-6 citation entailment 独立校验步；T1b-7 检索纪律（disconfirm-first/absence 正反/双语，进 brief 模板+自动质检）；T1b-8 benchmark runner（gold set→指标→Wilson/ECE 达标判定，T1a-0 直接消费）+ 档位预算。
- **1c**：T1c-1 渠道扩 L2≥2 平台+白名单；T1c-2 报告卡（BlockRenderer 新 `report` block + CollapsibleBlock 折叠证据链/分歧/引用）+ 进行中态（store-driven 渐进事件）；T1c-3 外发边界（provider allowlist 人工确认链 + 敏感命中强确认/阻断 + outbound_log 写入）;T1c-4 房间顶部搜索条（[核查/深搜] 切换，深搜 disabled/preview）+ slash `/fact-check` + 自然语言路由 + 执行前确认；T1c-5 缓存+freshness；T1c-6 保留/清理/脱敏；T1c-7 deep-research walking skeleton（fixture-provider 全链路，非 verdict projection）。
- **2**：T2-1 深搜入口 enable+维度拆解；T2-2 覆盖式检索+coverage matrix；T2-3 综合报告 projection；T2-4 底座共享 contract test。

# 检查点与纪律

- 每 Task 一 commit（worktree 内），commit 后 `git rev-parse` 真 hash；测试先红后绿；**写测试前实测被测契约**
- **无人值守批次纪律（德彪 plan review）**：任一 Task 的测试/typecheck 失败 → 修复为先，修不动即停批次写交接，**禁止跳过该 Task 继续后续或提交半绿 commit**；boot/集成测试显式传临时 SQLite/snapshot 路径 + `close()`，禁触默认 `.runtime` 持久数据（Iron Law §1）；长驻 undici Agent/HTTP server/timer 必须注册关闭钩子（防全量测试挂死）；测试禁 bind 真实 localhost 端口（注入 dispatcher 替代）
- Phase 1a 完成 → quality-gate → evidence pack → 德彪 code review → 小孙验收 → 才谈合 dev
- 单测 mock 必须复刻 prod schema 约束（triggers/UNIQUE/CHECK——[Test Schema Faithful to Prod]）
- 改 AC-P1b-9 任何冻结数字（73/189/0.6/0.8/0.95/≤0.1）= 设计变更，必须回 feature doc + review，代码注释已钉

# 时间线

| 日期 | 事件 |
|------|------|
| 2026-06-13 | plan v1（德彪终审 GO 后；通宵批次=T1a-0..10，0A 先行件时间允许才做） |
| 2026-06-13 | 德彪 plan review **NEEDS-WORK** → **v2 全收**：DB 三源真相（INIT_SQL 为生产首跑 DDL）+ parity 测试两路启动、shared 类型单一真相源 + QuestionUnit/RetrievalPlan 持久化 API、retry policy/partial 显式转移、registry 冻结窄 facade + 恶意 provider 测试、AC-P1a-3 改 T1a-7+T1b-4 双件关闭、corpus 升行为级断言、规范化快照定义、无人值守纪律（fail-fast/资源关闭/测试禁 bind 端口）。Wilson 73/189 边界他验算确认正确。T1a-0 已绿（worktree 0cc4b58） |
