export type AgentStatus = "idle" | "running" | "replying" | "thinking" | "error"

export type AppEvent =
  | {
      type: "invocation.started"
      invocationId: string
      threadId: string
      agentId: string
      callbackToken: string
      status: Extract<AgentStatus, "running">
      createdAt: string
      // F021 Phase 3.3: frozen per-provider runtime config snapshot captured
      // when this invocation started (pending flushed into active).
      configSnapshot?: Record<string, { model?: string; effort?: string }> | null
    }
  | {
      type: "invocation.activity"
      invocationId: string
      threadId: string
      agentId: string
      stream: "stdout" | "stderr"
      chunk: string
      status: Extract<AgentStatus, "replying" | "thinking">
      createdAt: string
    }
  | {
      type: "invocation.finished"
      invocationId: string
      threadId: string
      agentId: string
      status: Extract<AgentStatus, "idle">
      exitCode: number | null
      /** F040 D16：本 invocation 终稿 message id（出站账本 key + 空内容判定） */
      assistantMessageId: string | null
      /** F040 D16：所属 call tree root（=触发 turn 的 user message id，D15 出站溯源锚） */
      rootMessageId: string | null
      createdAt: string
    }
  | {
      type: "invocation.failed"
      invocationId: string
      threadId: string
      agentId: string
      status: Extract<AgentStatus, "error">
      error: string
      exitCode: number | null
      /** F040 D16：错误终态占位 message id（回执也要能溯源投递） */
      assistantMessageId: string | null
      /** F040 D16：所属 call tree root（D15 出站溯源锚） */
      rootMessageId: string | null
      createdAt: string
    }
