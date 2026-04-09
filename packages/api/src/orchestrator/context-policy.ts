/**
 * Context Policy determines which layers are injected into an agent's prompt.
 * Different scenarios (normal collab, Phase 1 brainstorm, document-only judge)
 * get different policies.
 */
export type ContextPolicy = {
  /** Inject rolling summary of the room (~1K tokens) */
  injectRollingSummary: boolean
  /** Inject this agent's own recent messages (skip if CLI can --resume) */
  injectSelfHistory: boolean
  /** Inject other agents' recent messages */
  injectSharedHistory: boolean
  /** Max messages for shared history */
  sharedHistoryLimit: number
  /** Max messages for self history */
  selfHistoryLimit: number
  /** Max characters per message in shared history (head+tail truncation) */
  maxContentLength: number
  /** Inject Phase 1 independent-thinking header */
  phase1Header: boolean
  /** Inject document/requirements preamble */
  injectPreamble: boolean
}

/** Normal collaboration: full context, all layers */
export const POLICY_FULL: ContextPolicy = {
  injectRollingSummary: true,
  injectSelfHistory: true,
  injectSharedHistory: true,
  sharedHistoryLimit: 10,
  selfHistoryLimit: 5,
  maxContentLength: 500,
  phase1Header: false,
  injectPreamble: false,
}

/** Phase 1 brainstorm: independent thinking, no cross-agent history */
export const POLICY_INDEPENDENT: ContextPolicy = {
  injectRollingSummary: true,
  injectSelfHistory: true,
  injectSharedHistory: false,
  sharedHistoryLimit: 0,
  selfHistoryLimit: 5,
  maxContentLength: 500,
  phase1Header: true,
  injectPreamble: false,
}

/** Document-only judge: only requirements doc, no conversation history */
export const POLICY_DOCUMENT_ONLY: ContextPolicy = {
  injectRollingSummary: false,
  injectSelfHistory: false,
  injectSharedHistory: false,
  sharedHistoryLimit: 0,
  selfHistoryLimit: 0,
  maxContentLength: 0,
  phase1Header: false,
  injectPreamble: true,
}

/** Vision Guardian: zero context, only the task message (feature doc + AC embedded in task) */
export const POLICY_GUARDIAN: ContextPolicy = {
  injectRollingSummary: false,
  injectSelfHistory: false,
  injectSharedHistory: false,
  sharedHistoryLimit: 0,
  selfHistoryLimit: 0,
  maxContentLength: 0,
  phase1Header: false,
  injectPreamble: false,
}
