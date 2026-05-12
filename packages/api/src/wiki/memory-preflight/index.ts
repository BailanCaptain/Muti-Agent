/**
 * F027 P11 · memory_preflight 模块 barrel export
 */

export * from "./types"
export { generateRecallQueries } from "./generate-queries"
export type { GenerateQueriesOptions } from "./generate-queries"
export { applyQualityGate } from "./quality-gate"
export type { ApplyQualityGateResult } from "./quality-gate"
export { detectRecallTrigger, conservativeStubJudge } from "./hard-gate"
export { renderTaskMemoryPack, toAssemblePromptHits } from "./render-pack"
export { InMemoryWikiSearchProvider, buildWikiEntityRecords } from "./in-memory-provider"
export type { WikiEntityRecord, EmbeddingGenerator } from "./in-memory-provider"
export { loadTaskMemoryPack, deriveAuditPatch } from "./memory-preflight"
export type { MemoryPreflightDeps, LoadTaskMemoryPackOptions } from "./memory-preflight"
