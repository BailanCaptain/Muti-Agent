export type AgentStatus = "idle" | "running" | "replying" | "thinking" | "error";

export type AppEvent =
  | {
      type: "invocation.started";
      invocationId: string;
      threadId: string;
      agentId: string;
      callbackToken: string;
      status: Extract<AgentStatus, "running">;
      createdAt: string;
    }
  | {
      type: "invocation.activity";
      invocationId: string;
      threadId: string;
      agentId: string;
      stream: "stdout" | "stderr";
      chunk: string;
      status: Extract<AgentStatus, "replying" | "thinking">;
      createdAt: string;
    }
  | {
      type: "invocation.finished";
      invocationId: string;
      threadId: string;
      agentId: string;
      status: Extract<AgentStatus, "idle">;
      exitCode: number | null;
      createdAt: string;
    }
  | {
      type: "invocation.failed";
      invocationId: string;
      threadId: string;
      agentId: string;
      status: Extract<AgentStatus, "error">;
      error: string;
      exitCode: number | null;
      createdAt: string;
    };
