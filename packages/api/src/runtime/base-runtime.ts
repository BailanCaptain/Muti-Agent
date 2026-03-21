import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** 一轮对话历史。这里只保留 role + content，供 runtime 组装 prompt。 */
export type ConversationHistory = Array<{ role: "user" | "assistant"; content: string }>;

/**
 * 上层传给 runtime 的统一输入。
 * runtime 不关心消息从前端来的还是从 A2A 队列来的，只关心这份标准化输入。
 */
export type AgentRunInput = {
  /** 本次运行的唯一 ID。callback 身份、事件记录都会围绕它展开。 */
  invocationId: string;
  /** 本次运行属于哪个 thread。 */
  threadId: string;
  /** 当前运行中的 agent 标识，通常是别名或 provider 名。 */
  agentId: string;
  /** 最终要喂给 CLI 的 prompt。 */
  prompt: string;
  /** 进程工作目录；不传时默认使用当前项目目录。 */
  cwd?: string;
  /**
   * 运行时环境变量。
   * 这里会放 callback token、system prompt、当前模型、native session id 等运行期信息。
   */
  env?: Record<string, string>;
};

/**
 * runtime 返回给上层的统一输出。
 * 上层只处理这个结构，不关心底层是哪家 CLI。
 */
export type AgentRunOutput = {
  /** runtime 尝试抽取出的最终文本；有些 CLI 可能拿不到，允许为空。 */
  finalText?: string;
  /** 本次运行 stdout 的完整原始文本。调试时很有用。 */
  rawStdout: string;
  /** 本次运行 stderr 的完整原始文本。thinking / tool 过程通常会出现在这里。 */
  rawStderr: string;
  /** 进程退出码。 */
  exitCode: number | null;
};

/** 三家运行时适配器都要实现的最小接口。 */
export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

/**
 * runtime 最终要执行的命令描述。
 * 这是“统一 runtime 接口”和“真实 CLI 命令细节”之间的中间层。
 */
export type RuntimeCommand = {
  /** 真正要执行的命令，例如 node / codex.cmd。 */
  command: string;
  /** 命令参数数组。 */
  args: string[];
  /** 是否通过 shell 运行。Windows 下有些 CLI 需要 shell 包装。 */
  shell: boolean;
  /** 本次运行结束后要执行的清理动作，例如删除临时 MCP 配置。 */
  cleanup?: () => void | Promise<void>;
};

/** 运行流上的钩子，供上层拿增量输出和活动信号。 */
export type RuntimeStreamHooks = {
  /** stdout 每读到一行就会回调。 */
  onStdoutLine?: (line: string) => void;
  /** stderr 每读到一块数据就会回调。 */
  onStderrChunk?: (chunk: string) => void;
  /**
   * 统一活动事件。
   * 不管 stdout 还是 stderr，只要有数据，就说明 agent 还活着。
   */
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void;
};

/**
 * 对外暴露的一次运行句柄。
 * 上层拿到它后可以：
 * 1. 调 cancel 终止运行
 * 2. 等 promise 获取最终结果
 */
export type RuntimeExecutionHandle = {
  /** 主动停止本次 CLI 运行。 */
  cancel: () => void;
  /** 本次运行完成后的最终结果。 */
  promise: Promise<AgentRunOutput>;
};

export abstract class BaseCliRuntime implements AgentRuntime {
  /** 当前 runtime 对应哪个 provider。 */
  abstract readonly agentId: string;

  run(input: AgentRunInput): Promise<AgentRunOutput> {
    return this.runStream(input).promise;
  }

  runStream(input: AgentRunInput, hooks: RuntimeStreamHooks = {}): RuntimeExecutionHandle {
    const command = this.buildCommand(input);
    const child = spawn(command.command, command.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env
      },
      shell: command.shell,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let rawStdout = "";
    let rawStderr = "";
    let cancelled = false;
    let lastActivityAt: string | null = null;

    const promise = new Promise<AgentRunOutput>((resolve, reject) => {
      const lines = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });

      lines.on("line", (line) => {
        const now = new Date().toISOString();
        // stdout 有数据，说明 agent 正在活跃。
        lastActivityAt = now;
        rawStdout += `${line}\n`;
        hooks.onStdoutLine?.(line);
        hooks.onActivity?.({ stream: "stdout", at: now, chunk: line });
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        const now = new Date().toISOString();
        // stderr 也必须算活跃信号，因为很多 CLI 会把 thinking / tool 日志写到这里。
        lastActivityAt = now;
        rawStderr += text;
        hooks.onStderrChunk?.(text);
        hooks.onActivity?.({ stream: "stderr", at: now, chunk: text });
      });

      child.on("error", reject);
      child.on("close", (code) => {
        Promise.resolve(command.cleanup?.())
          .catch(() => undefined)
          .finally(() => {
            resolve({
              finalText: this.extractFinalText(rawStdout),
              rawStdout,
              rawStderr,
              exitCode: cancelled && code === null ? 0 : code
            });
          });
      });
    });

    return {
      cancel() {
        cancelled = true;
        child.kill();
      },
      promise
    };
  }

  /** 子类负责把统一输入转换成真实 CLI 命令。 */
  protected abstract buildCommand(input: AgentRunInput): RuntimeCommand;

  /** 子类可覆盖这个方法，自定义如何从 stdout 抽出最终文本。 */
  protected extractFinalText(rawStdout: string) {
    return rawStdout.trim() || undefined;
  }
}

export function resolveNpmRoot() {
  const candidates = [
    path.join(process.env.APPDATA || "", "npm"),
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm")
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

export function resolveNodeScript(packageName: string, relativeScriptPath: string[]) {
  const npmRoot = resolveNpmRoot();
  const scriptPath = npmRoot ? path.join(npmRoot, "node_modules", packageName, ...relativeScriptPath) : "";

  if (scriptPath && existsSync(scriptPath)) {
    return {
      command: process.execPath,
      prefixArgs: [scriptPath],
      shell: false
    };
  }

  return {
    command: relativeScriptPath.at(-1)?.replace(/\.js$/, "") ?? packageName,
    prefixArgs: [],
    shell: true
  };
}

export function buildHistoryPrompt(history: ConversationHistory, userMessage: string) {
  if (!history.length) {
    return userMessage;
  }

  // 这里只取最近 12 条，避免 prompt 无限制膨胀。
  const transcript = history
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n\n");

  return [
    "Continue the conversation below.",
    "Keep the existing context and answer the final user message directly.",
    "",
    transcript,
    "",
    `User: ${userMessage}`
  ].join("\n");
}

export function findSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  if (typeof value.session_id === "string" && value.session_id) {
    return value.session_id;
  }
  if (typeof value.sessionId === "string" && value.sessionId) {
    return value.sessionId;
  }

  for (const child of Object.values(value)) {
    const nested = findSessionId(child);
    if (nested) {
      return nested;
    }
  }

  return null;
}

/** 从 CLI 事件里尽量抽取当前模型名。 */
export function parseEventModel(event: Record<string, unknown>) {
  return typeof event.model === "string"
    ? event.model
    : typeof (event.message as { model?: string } | undefined)?.model === "string"
      ? (event.message as { model: string }).model
      : null;
}

/** 把系统说明包在用户请求前面，得到最终给 CLI 的 prompt。 */
export function wrapPromptWithInstructions(instructions: string, userPrompt: string) {
  return [instructions.trim(), "", "User request:", userPrompt].join("\n");
}

