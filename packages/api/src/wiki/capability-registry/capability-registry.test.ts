/**
 * F027 P9 · alias-aware capability registry + handoff 中性改写 单测
 * 真相源：docs/plans/V16.5-final.md chap 13 行 1447-1525
 * AC: AC-P1-13 ——
 *   sender alias 黄仁勋 → @桂芬 时，receiver 看到的 prompt
 *   不暴露 sender risks（top_risks / must_not / capability_digest_for_self）
 * Fixture：tests/fixtures/capability-registry/{red-leaks-sender-risk,green-neutralized}.json
 *
 * 覆盖：
 *   - loader：4 agent 全在 + 6 槽位齐全；缺失字段 / 缺 agent / 错类型 各路径
 *   - rewriter：sender 槽位绝不出现在 envelope；receiver digest 来自 registry
 *   - leak-detector：red fixture 必命中；green fixture 必 clean
 *   - 端到端：rewriteHandoffForReceiver(...) → detectSenderRiskLeak(...) hasLeak=false
 */

import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import test from "node:test"
import {
  CAPABILITY_REGISTRY_RELATIVE_PATH,
  loadCapabilityRegistry,
  loadCapabilityRegistryFromRoot,
  REQUIRED_AGENTS,
  REQUIRED_CAPABILITY_SLOTS,
} from "./loader"
import {
  getSelfCapabilityDigest,
  rewriteHandoffForReceiver,
} from "./handoff-rewriter"
import { detectSenderRiskLeak } from "./leak-detector"
import {
  CapabilityRegistryError,
  type ReceiverHandoffEnvelope,
  UnknownReceiverError,
} from "./types"

// dist 跑时 __dirname = packages/api/dist/wiki/capability-registry/
// 向上 4 层到 packages/api → 再上 2 层到 worktree root
const REPO_ROOT = path.resolve(__dirname, "../../../../..")

// ─── loader ──────────────────────────────────────────────────────────

test("loader: wiki/agents/agent-capabilities.yaml 真实文件加载 + 4 agent 齐", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  for (const agentName of REQUIRED_AGENTS) {
    assert.ok(registry.agents.has(agentName), `${agentName} 必须在 registry`)
    const cap = registry.agents.get(agentName)
    assert.ok(cap)
    for (const slot of REQUIRED_CAPABILITY_SLOTS) {
      assert.ok(slot in cap, `${agentName}.${slot} 必须存在`)
    }
  }
})

test("loader: 文件不存在 → CapabilityRegistryError", () => {
  assert.throws(
    () => loadCapabilityRegistry("/nonexistent/path/file.yaml"),
    (err) =>
      err instanceof CapabilityRegistryError &&
      /not found/.test(err.message),
  )
})

test("loader: 缺 agent → CapabilityRegistryError + missingAgents 列表", () => {
  const tmp = writeTmpYaml(`
agents:
  小孙:
    role: x
    tools_limits: ["a"]
    must_do: ["a"]
    must_not: ["a"]
    top_risks: [{id: "LL-1", text: "abc12345"}]
    handoff_contract: ["a"]
    capability_digest_for_self: "x"
`)
  try {
    assert.throws(
      () => loadCapabilityRegistry(tmp),
      (err) => {
        if (!(err instanceof CapabilityRegistryError)) return false
        // 缺黄/范/桂 3 个
        return err.missingAgents?.length === 3
      },
    )
  } finally {
    fs.unlinkSync(tmp)
  }
})

test("loader: 缺槽位 → CapabilityRegistryError + missingFields 列表", () => {
  const tmp = writeTmpYaml(`
agents:
  小孙: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
  黄仁勋: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
  范德彪: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
  桂芬: { role: "x", tools_limits: ["a"], must_do: ["a"] }
`)
  try {
    assert.throws(
      () => loadCapabilityRegistry(tmp),
      (err) =>
        err instanceof CapabilityRegistryError &&
        (err.missingFields?.length ?? 0) >= 4 &&
        /桂芬/.test(err.message),
    )
  } finally {
    fs.unlinkSync(tmp)
  }
})

test("loader: top_risks 不是 array → CapabilityRegistryError", () => {
  const tmp = writeTmpYaml(`
agents:
  小孙: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: "not array", handoff_contract: ["a"], capability_digest_for_self: "x" }
  黄仁勋: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
  范德彪: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
  桂芬: { role: "x", tools_limits: ["a"], must_do: ["a"], must_not: ["a"], top_risks: [{id: "LL-1", text: "abc12345"}], handoff_contract: ["a"], capability_digest_for_self: "x" }
`)
  try {
    assert.throws(
      () => loadCapabilityRegistry(tmp),
      (err) =>
        err instanceof CapabilityRegistryError && /top_risks/.test(err.message),
    )
  } finally {
    fs.unlinkSync(tmp)
  }
})

// ─── rewriter ────────────────────────────────────────────────────────

test("rewriter: 黄仁勋 → 桂芬 envelope 严格 4 字段，sender 槽位 0 出现", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const sender = registry.agents.get("黄仁勋")
  assert.ok(sender)

  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "桂芬",
      task: "把 F018 的 message schema 加 chained_suspect 字段",
      contextSummary: "F027 P4.5 已合，需要 P6 IngestModal 串起来",
      expectedEvidence: ["改完跑 pnpm test:api 全绿"],
    },
    registry,
  )

  // 字段固定（含 metadata sender_alias / receiver_alias + 4 主字段）
  assert.equal(env.sender_alias, "黄仁勋")
  assert.equal(env.receiver_alias, "桂芬")
  assert.equal(env.task, "把 F018 的 message schema 加 chained_suspect 字段")
  assert.match(env.receiver_capability_digest, /桂芬/)
  assert.equal(env.collaboration_contract.do_not_section.length, 0)

  // sender 任何 sensitive 字段都不能出现
  const envJson = JSON.stringify(env)
  for (const risk of sender.top_risks) {
    assert.ok(
      !envJson.includes(risk.text),
      `sender top_risks "${risk.text}" 不应出现在 envelope`,
    )
    assert.ok(
      !envJson.includes(risk.id),
      `sender top_risks id "${risk.id}" 不应出现`,
    )
  }
  for (const m of sender.must_not) {
    assert.ok(!envJson.includes(m), `sender must_not "${m}" 不应出现`)
  }
})

test("rewriter: receiver_capability_digest 完全等于 registry 里 receiver 的 digest", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "桂芬",
      task: "x",
    },
    registry,
  )
  const expected = registry.agents.get("桂芬")?.capability_digest_for_self.trim()
  assert.equal(env.receiver_capability_digest, expected)
})

test("rewriter: receiver 的 handoff_contract 进 expected_evidence + dedupe", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "桂芬",
      task: "x",
      expectedEvidence: ["接 F018 任务前必须读 SessionBootstrap"], // 故意和 receiver 的 handoff_contract 撞
    },
    registry,
  )
  const seen = new Set(env.collaboration_contract.expected_evidence)
  assert.equal(
    seen.size,
    env.collaboration_contract.expected_evidence.length,
    "expected_evidence 不应有重复条目",
  )
})

test("rewriter: 未知 receiver → UnknownReceiverError", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  assert.throws(
    () =>
      rewriteHandoffForReceiver(
        { senderAlias: "黄仁勋", receiverAlias: "ghost-agent", task: "x" },
        registry,
      ),
    (err) => err instanceof UnknownReceiverError,
  )
})

test("rewriter: do_not_section 恒空（V16.5 chap 13 行 1489）", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "范德彪",
      task: "review F027 P9",
    },
    registry,
  )
  assert.equal(env.collaboration_contract.do_not_section.length, 0)
})

test("rewriter: task / contextSummary 自动 trim", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "桂芬",
      task: "  trimmed task  \n\n",
      contextSummary: "  trimmed ctx  ",
    },
    registry,
  )
  assert.equal(env.task, "trimmed task")
  assert.equal(env.collaboration_contract.context_summary, "trimmed ctx")
})

test("getSelfCapabilityDigest: 返回 self digest 用于 wake-up 注入", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const digest = getSelfCapabilityDigest("黄仁勋", registry)
  assert.match(digest, /黄仁勋/)
  assert.match(digest, /主架构师|F027/)
})

test("getSelfCapabilityDigest: 未知 agent → 抛错", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  assert.throws(() => getSelfCapabilityDigest("ghost", registry))
})

// ─── leak detector ───────────────────────────────────────────────────

test("leak-detector: GREEN fixture 必 clean（hasLeak=false）", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const fixturePath = path.join(
    REPO_ROOT,
    "tests/fixtures/capability-registry/green-neutralized.json",
  )
  const env = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as ReceiverHandoffEnvelope
  const result = detectSenderRiskLeak(env, registry)
  assert.equal(
    result.hasLeak,
    false,
    `green fixture 不应有 leak，实际 findings: ${JSON.stringify(result.findings)}`,
  )
})

test("leak-detector: RED fixture 必命中 ≥1 finding", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const fixturePath = path.join(
    REPO_ROOT,
    "tests/fixtures/capability-registry/red-leaks-sender-risk.json",
  )
  const env = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as ReceiverHandoffEnvelope
  const result = detectSenderRiskLeak(env, registry)
  assert.ok(result.hasLeak, "red fixture 必须命中 leak，但 findings 为空")
  // 应该至少抓到 黄仁勋 的某个 sensitive 字段
  const huangFindings = result.findings.filter((f) => f.sourceAgent === "黄仁勋")
  assert.ok(huangFindings.length > 0, "应抓到黄仁勋 sender risks 漏出")
})

test("leak-detector: 端到端 — rewriter 产物必过 leak-detector 0 finding", () => {
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const env = rewriteHandoffForReceiver(
    {
      senderAlias: "黄仁勋",
      receiverAlias: "桂芬",
      task: "把 F018 的 message schema 加字段",
      contextSummary: "F027 P4.5 已合",
      expectedEvidence: ["改完跑 pnpm test:api 全绿"],
    },
    registry,
  )
  const result = detectSenderRiskLeak(env, registry)
  assert.equal(
    result.hasLeak,
    false,
    `rewriter 产物必须 0 leak，实际 findings: ${JSON.stringify(result.findings)}`,
  )
})

test("leak-detector: receiver 自己的 sensitive 字段不算 leak", () => {
  // 桂芬 接 handoff，envelope 含桂芬自己的 must_not（如 "不能改 packages/api/runtime/*"）
  // 不应被算作 leak（receiver 自己的 data 给 receiver 看天经地义）
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const guifenCap = registry.agents.get("桂芬")
  assert.ok(guifenCap)
  const guifenMustNot = guifenCap.must_not[0]

  const env: ReceiverHandoffEnvelope = {
    sender_alias: "黄仁勋",
    receiver_alias: "桂芬",
    task: "x",
    receiver_capability_digest: guifenCap.capability_digest_for_self.trim(),
    collaboration_contract: {
      sender_alias: "黄仁勋",
      // 故意把 桂芬 的 must_not 嵌进 context_summary —— 不应被报 leak
      context_summary: `regular context but mentions: ${guifenMustNot}`,
      expected_evidence: [],
      receiver_must_do: [],
      do_not_section: [],
    },
  }
  const result = detectSenderRiskLeak(env, registry)
  // 不应抓桂芬自己的 must_not
  const guifenLeaks = result.findings.filter((f) => f.sourceAgent === "桂芬")
  assert.equal(guifenLeaks.length, 0, "receiver 自己的 sensitive 字段不应被算 leak")
})

test("leak-detector: 注入式攻击 — sender 故意在 task 里嵌 receiver 内部 risks", () => {
  // sender 黄仁勋 想把 范德彪 的 risks 暴露给 桂芬（恶意 cross-leak）
  // 范的 must_not "不在 sandbox 报错时谎称'测试都过了'" 嵌进 task
  const registry = loadCapabilityRegistryFromRoot(REPO_ROOT)
  const fanCap = registry.agents.get("范德彪")
  assert.ok(fanCap)
  const fanRiskText = fanCap.must_not.find((m) => m.length >= 10) ?? fanCap.must_not[0]

  const env: ReceiverHandoffEnvelope = {
    sender_alias: "黄仁勋",
    receiver_alias: "桂芬",
    // 把范的 must_not 嵌在 task 里给桂芬看
    task: `do this thing. note: ${fanRiskText}`,
    receiver_capability_digest: registry.agents.get("桂芬")!.capability_digest_for_self.trim(),
    collaboration_contract: {
      sender_alias: "黄仁勋",
      context_summary: "",
      expected_evidence: [],
      receiver_must_do: [],
      do_not_section: [],
    },
  }
  const result = detectSenderRiskLeak(env, registry)
  assert.ok(result.hasLeak, "范德彪的 must_not 嵌入 task 应被检出")
  const fanLeaks = result.findings.filter((f) => f.sourceAgent === "范德彪")
  assert.ok(fanLeaks.length > 0)
})

// ─── helpers ─────────────────────────────────────────────────────────

function writeTmpYaml(content: string): string {
  const tmpDir = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "f027-p9-test-"),
  )
  const file = path.join(tmpDir, "agent-capabilities.yaml")
  fs.writeFileSync(file, content, "utf-8")
  return file
}
