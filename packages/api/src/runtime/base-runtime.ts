import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type RuntimeLifecycleConfig = {
  heartbeatIntervalMs: number;
  inactivityTimeoutMs: number;
  shutdownGracePeriodMs: number;
};

export type AgentRunInput = {
  invocationId: string;
  threadId: string;
  agentId: string;
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
  runtime?: Partial<RuntimeLifecycleConfig>;
};

export type AgentRunOutput = {
  finalText?: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
};

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

export type RuntimeCommand = {
  command: string;
  args: string[];
  shell: boolean;
  cleanup?: () => void | Promise<void>;
};

export type RuntimeStreamHooks = {
  onStdoutLine?: (line: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void;
};

export type RuntimeExecutionHandle = {
  cancel: () => void;
  promise: Promise<AgentRunOutput>;
};

type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof spawn>[2]
) => ChildProcessWithoutNullStreams;

export type RuntimeDependencies = {
  spawn?: SpawnLike;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  platform?: NodeJS.Platform;
  forceKillProcessTree?: (pid: number) => void;
};

const DEFAULT_RUNTIME_LIFECYCLE: RuntimeLifecycleConfig = {
  heartbeatIntervalMs: 30_000,
  inactivityTimeoutMs: 5 * 60_000,
  shutdownGracePeriodMs: 5_000
};

function readMs(preferred: number | undefined, fallback: string | undefined, defaultValue: number) {
  if (typeof preferred === "number" && Number.isFinite(preferred) && preferred >= 0) {
    return preferred;
  }

  const parsed = Number(fallback);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return defaultValue;
}

function formatRuntimeTimeoutMessage(inactivityTimeoutMs: number, lastActivityAt: string) {
  const seconds = Math.round(inactivityTimeoutMs / 1000);
  const minutes = inactivityTimeoutMs >= 60_000 ? `（约 ${Math.round(inactivityTimeoutMs / 60_000)} 分钟）` : "";
  return `Agent 好像睡着了，已经有 ${seconds} 秒${minutes} 没有新活动。最后一次活动时间：${lastActivityAt}。请检查它的状态或重试一次。`;
}

function defaultForceKillProcessTree(pid: number) {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    shell: true,
    stdio: "ignore",
    windowsHide: true
  });

  killer.on("error", () => undefined);
  killer.unref();
}

export function resolveRuntimeLifecycleConfig(
  runtime?: Partial<RuntimeLifecycleConfig>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): RuntimeLifecycleConfig {
  return {
    heartbeatIntervalMs: readMs(
      runtime?.heartbeatIntervalMs,
      env.MULTI_AGENT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_RUNTIME_LIFECYCLE.heartbeatIntervalMs
    ),
    inactivityTimeoutMs: readMs(
      runtime?.inactivityTimeoutMs,
      env.MULTI_AGENT_INACTIVITY_TIMEOUT_MS,
      DEFAULT_RUNTIME_LIFECYCLE.inactivityTimeoutMs
    ),
    shutdownGracePeriodMs: readMs(
      runtime?.shutdownGracePeriodMs,
      env.MULTI_AGENT_SHUTDOWN_GRACE_PERIOD_MS,
      DEFAULT_RUNTIME_LIFECYCLE.shutdownGracePeriodMs
    )
  };
}

export abstract class BaseCliRuntime implements AgentRuntime {
  abstract readonly agentId: string;

  constructor(private readonly dependencies: RuntimeDependencies = {}) {}

  run(input: AgentRunInput): Promise<AgentRunOutput> {
    return this.runStream(input).promise;
  }

  runStream(input: AgentRunInput, hooks: RuntimeStreamHooks = {}): RuntimeExecutionHandle {
    const command = this.buildCommand(input);
    const env = {
      ...process.env,
      ...input.env
    };
    const lifecycle = resolveRuntimeLifecycleConfig(input.runtime, env);
    const spawnProcess = this.dependencies.spawn ?? spawn;
    const now = this.dependencies.now ?? Date.now;
    const setTimeoutImpl = this.dependencies.setTimeout ?? globalThis.setTimeout;
    const clearTimeoutImpl = this.dependencies.clearTimeout ?? globalThis.clearTimeout;
    const setIntervalImpl = this.dependencies.setInterval ?? globalThis.setInterval;
    const clearIntervalImpl = this.dependencies.clearInterval ?? globalThis.clearInterval;
    const platform = this.dependencies.platform ?? process.platform;
    const forceKillProcessTree = this.dependencies.forceKillProcessTree ?? defaultForceKillProcessTree;
    const child = spawnProcess(command.command, command.args, {
      cwd: input.cwd,
      env,
      shell: command.shell,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let rawStdout = "";
    let rawStderr = "";
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let terminationStarted = false;
    let lastActivityMs = now();
    let lastActivityAt = new Date(lastActivityMs).toISOString();
    let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    let forceKillTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const clearTimers = () => {
      if (heartbeatTimer) {
        clearIntervalImpl(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      if (forceKillTimer) {
        clearTimeoutImpl(forceKillTimer);
        forceKillTimer = undefined;
      }
    };

    const recordActivity = (stream: "stdout" | "stderr", chunk: string) => {
      lastActivityMs = now();
      lastActivityAt = new Date(lastActivityMs).toISOString();
      hooks.onActivity?.({ stream, at: lastActivityAt, chunk });
    };

    const forceKill = () => {
      if (child.exitCode !== null) {
        return;
      }

      if (platform === "win32" && typeof child.pid === "number") {
        forceKillProcessTree(child.pid);
        return;
      }

      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    };

    const requestTermination = () => {
      if (terminationStarted) {
        return;
      }

      terminationStarted = true;
      clearTimers();

      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }

      if (lifecycle.shutdownGracePeriodMs <= 0) {
        forceKill();
        return;
      }

      forceKillTimer = setTimeoutImpl(() => {
        forceKill();
      }, lifecycle.shutdownGracePeriodMs);
    };

    const promise = new Promise<AgentRunOutput>((resolve, reject) => {
      const lines = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        lines.close();

        Promise.resolve(command.cleanup?.())
          .catch(() => undefined)
          .finally(callback);
      };

      lines.on("line", (line) => {
        rawStdout += `${line}\n`;
        hooks.onStdoutLine?.(line);
        recordActivity("stdout", line);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        rawStderr += text;
        hooks.onStderrChunk?.(text);
        recordActivity("stderr", text);
      });

      child.on("error", (error) => {
        settle(() => reject(error));
      });

      child.on("close", (code) => {
        settle(() => {
          if (timedOut) {
            reject(new Error(formatRuntimeTimeoutMessage(lifecycle.inactivityTimeoutMs, lastActivityAt)));
            return;
          }

          resolve({
            finalText: this.extractFinalText(rawStdout),
            rawStdout,
            rawStderr,
            exitCode: cancelled && code === null ? 0 : code
          });
        });
      });

      if (lifecycle.heartbeatIntervalMs > 0 && lifecycle.inactivityTimeoutMs > 0) {
        heartbeatTimer = setIntervalImpl(() => {
          if (terminationStarted) {
            return;
          }

          if (now() - lastActivityMs < lifecycle.inactivityTimeoutMs) {
            return;
          }

          timedOut = true;
          rawStderr = rawStderr
            ? `${rawStderr.trimEnd()}\n[runtime] ${formatRuntimeTimeoutMessage(lifecycle.inactivityTimeoutMs, lastActivityAt)}\n`
            : `[runtime] ${formatRuntimeTimeoutMessage(lifecycle.inactivityTimeoutMs, lastActivityAt)}\n`;
          requestTermination();
        }, lifecycle.heartbeatIntervalMs);
      }
    });

    return {
      cancel() {
        cancelled = true;
        requestTermination();
      },
      promise
    };
  }

  protected abstract buildCommand(input: AgentRunInput): RuntimeCommand;

  parseActivityLine(_event: Record<string, unknown>): string | null {
    return null;
  }

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

export function parseEventModel(event: Record<string, unknown>) {
  return typeof event.model === "string"
    ? event.model
    : typeof (event.message as { model?: string } | undefined)?.model === "string"
      ? (event.message as { model: string }).model
      : null;
}

export function wrapPromptWithInstructions(instructions: string, userPrompt: string) {
  return [instructions.trim(), "", "User request:", userPrompt].join("\n");
}
