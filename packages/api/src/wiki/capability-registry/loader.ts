/**
 * F027 P9 · capability registry loader
 * 真相源：docs/plans/V16.5-final.md chap 13 行 1449-1476
 *
 * 加载 wiki/agents/agent-capabilities.yaml + 6 槽位强制校验。
 * 缺字段 / 缺 agent → 抛 CapabilityRegistryError，让 caller 直接 fail-loud
 * （registry 是安全契约的基础数据，不能 silently 用半残的 registry）。
 */

import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import {
  type AgentCapability,
  type CapabilityRegistry,
  CapabilityRegistryError,
} from "./types"

export const REQUIRED_AGENTS = ["小孙", "黄仁勋", "范德彪", "桂芬"] as const
export const REQUIRED_CAPABILITY_SLOTS = [
  "role",
  "tools_limits",
  "must_do",
  "must_not",
  "top_risks",
  "handoff_contract",
  "capability_digest_for_self",
] as const

/** 默认 registry path（相对 repo root） */
export const CAPABILITY_REGISTRY_RELATIVE_PATH = "wiki/agents/agent-capabilities.yaml"

export function loadCapabilityRegistry(absolutePath: string): CapabilityRegistry {
  if (!fs.existsSync(absolutePath)) {
    throw new CapabilityRegistryError(
      `capability registry file not found: ${absolutePath}`,
      { sourcePath: absolutePath },
    )
  }
  const raw = fs.readFileSync(absolutePath, "utf-8")
  let parsed: unknown
  try {
    parsed = yaml.parse(raw)
  } catch (err) {
    throw new CapabilityRegistryError(
      `capability registry yaml parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { sourcePath: absolutePath },
    )
  }
  return validateAndBuild(parsed, absolutePath)
}

/**
 * 从 wikiRoot（含 wiki/ 子目录的根）加载 default path。
 * caller 一般是 runtime / test，wikiRoot = repo root。
 */
export function loadCapabilityRegistryFromRoot(wikiRoot: string): CapabilityRegistry {
  return loadCapabilityRegistry(path.join(wikiRoot, CAPABILITY_REGISTRY_RELATIVE_PATH))
}

function validateAndBuild(parsed: unknown, sourcePath: string): CapabilityRegistry {
  if (!isObject(parsed) || !isObject((parsed as { agents?: unknown }).agents)) {
    throw new CapabilityRegistryError(
      `capability registry must have top-level "agents" mapping`,
      { sourcePath },
    )
  }
  const agentsRaw = (parsed as { agents: Record<string, unknown> }).agents

  // 强制 4 个固定 agent 都存在（小孙 / 黄仁勋 / 范德彪 / 桂芬）
  const missingAgents = REQUIRED_AGENTS.filter((name) => !(name in agentsRaw))
  if (missingAgents.length > 0) {
    throw new CapabilityRegistryError(
      `capability registry missing required agents: ${missingAgents.join(", ")}`,
      { sourcePath, missingAgents: [...missingAgents] },
    )
  }

  const agents = new Map<string, AgentCapability>()
  for (const [name, capRaw] of Object.entries(agentsRaw)) {
    const cap = parseAgentCapability(name, capRaw, sourcePath)
    agents.set(name, cap)
  }

  return { agents, sourcePath }
}

function parseAgentCapability(
  name: string,
  raw: unknown,
  sourcePath: string,
): AgentCapability {
  if (!isObject(raw)) {
    throw new CapabilityRegistryError(
      `agent "${name}" capability must be a mapping, got ${typeof raw}`,
      { sourcePath },
    )
  }
  const obj = raw as Record<string, unknown>

  // 6 槽位 + role 全检
  const missingFields = REQUIRED_CAPABILITY_SLOTS.filter((slot) => !(slot in obj))
  if (missingFields.length > 0) {
    throw new CapabilityRegistryError(
      `agent "${name}" missing required slots: ${missingFields.join(", ")}`,
      { sourcePath, missingFields },
    )
  }

  // 类型校验
  assertString(name, "role", obj.role, sourcePath)
  assertStringArray(name, "tools_limits", obj.tools_limits, sourcePath)
  assertStringArray(name, "must_do", obj.must_do, sourcePath)
  assertStringArray(name, "must_not", obj.must_not, sourcePath)
  assertString(name, "capability_digest_for_self", obj.capability_digest_for_self, sourcePath)
  assertStringArray(name, "handoff_contract", obj.handoff_contract, sourcePath)

  // top_risks: Array<{id, text}>
  if (!Array.isArray(obj.top_risks)) {
    throw new CapabilityRegistryError(
      `agent "${name}" top_risks must be array, got ${typeof obj.top_risks}`,
      { sourcePath },
    )
  }
  const topRisks: Array<{ id: string; text: string }> = []
  for (const [i, riskRaw] of obj.top_risks.entries()) {
    if (!isObject(riskRaw)) {
      throw new CapabilityRegistryError(
        `agent "${name}" top_risks[${i}] must be {id, text} object`,
        { sourcePath },
      )
    }
    const risk = riskRaw as Record<string, unknown>
    if (typeof risk.id !== "string" || typeof risk.text !== "string") {
      throw new CapabilityRegistryError(
        `agent "${name}" top_risks[${i}] needs string id + text`,
        { sourcePath },
      )
    }
    topRisks.push({ id: risk.id, text: risk.text })
  }

  return {
    role: obj.role as string,
    tools_limits: obj.tools_limits as string[],
    must_do: obj.must_do as string[],
    must_not: obj.must_not as string[],
    top_risks: topRisks,
    handoff_contract: obj.handoff_contract as string[],
    capability_digest_for_self: obj.capability_digest_for_self as string,
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function assertString(agent: string, field: string, v: unknown, sourcePath: string): void {
  if (typeof v !== "string" || v.length === 0) {
    throw new CapabilityRegistryError(
      `agent "${agent}" field "${field}" must be non-empty string`,
      { sourcePath },
    )
  }
}

function assertStringArray(agent: string, field: string, v: unknown, sourcePath: string): void {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) {
    throw new CapabilityRegistryError(
      `agent "${agent}" field "${field}" must be array of non-empty strings`,
      { sourcePath },
    )
  }
}
