import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  ProcessLivenessProbe,
  type LivenessProbeConfig,
  type LivenessWarning,
  type ProcessLivenessProbeDependencies
} from "./liveness-probe";

export type RuntimeLifecycleConfig = {
  heartbeatIntervalMs: number;
  inactivityTimeoutMs: number;
  shutdownGracePeriodMs: number;
  livenessSampleIntervalMs: number;
  livenessSoftWarningMs: number;
  livenessStallWarningMs: number;
  livenessBoundedExtensionFactor: number;
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

export type StopReason =
  | "complete"
  | "truncated"
  | "refused"
  | "tool_wait"
  | "aborted";

export type AgentRunOutput = {
  finalText?: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
  stopReason: StopReason | null;
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
  onLivenessWarning?: (warning: LivenessWarning) => void;
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
  createLivenessProbe?: (pid: number, config: LivenessProbeConfig) => ProcessLivenessProbe;
};

const DEFAULT_RUNTIME_LIFECYCLE: RuntimeLifecycleConfig = {
  heartbeatIntervalMs: 30_000,
  inactivityTimeoutMs: 5 * 60_000,
  shutdownGracePeriodMs: 5_000,
  livenessSampleIntervalMs: 30_000,
  livenessSoftWarningMs: 90_000,
  livenessStallWarningMs: 180_000,
  livenessBoundedExtensionFactor: 2.0
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

function formatRuntimeTimeoutMessage(
  inactivityTimeoutMs: number,
  lastActivityAt: string,
  reason: "timeout" | "stall" | "dead" = "timeout"
) {
  const seconds = Math.round(inactivityTimeoutMs / 1000);
  const minutes = inactivityTimeoutMs >= 60_000 ? `（约 ${Math.round(inactivityTimeoutMs / 60_000)} 分钟）` : "";
  if (reason === "stall") {
    return `Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ ${seconds} 秒${minutes}）。最后一次活动时间：${lastActivityAt}。已强制终止，请重试一次。`;
  }
  if (reason === "dead") {
    return `Agent 进程已异常退出。最后一次活动时间：${lastActivityAt}。请重试一次。`;
  }
  return `Agent 好像睡着了，已经有 ${seconds} 秒${minutes} 没有新活动。最后一次活动时间：${lastActivityAt}。请检查它的状态或重试一次。`;
}

function formatFastFailMessage(reason: string) {
  return `Agent CLI 触发已知的致命错误（${reason}），已提前终止避免陷入长时间重试循环。请重试一次。`;
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
  const factorRaw = Number(env.MULTI_AGENT_LIVENESS_BOUNDED_EXTENSION_FACTOR);
  const factor =
    typeof runtime?.livenessBoundedExtensionFactor === "number" &&
    Number.isFinite(runtime.livenessBoundedExtensionFactor) &&
    runtime.livenessBoundedExtensionFactor > 0
      ? runtime.livenessBoundedExtensionFactor
      : Number.isFinite(factorRaw) && factorRaw > 0
        ? factorRaw
        : DEFAULT_RUNTIME_LIFECYCLE.livenessBoundedExtensionFactor;
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
    ),
    livenessSampleIntervalMs: readMs(
      runtime?.livenessSampleIntervalMs,
      env.MULTI_AGENT_LIVENESS_SAMPLE_INTERVAL_MS,
      DEFAULT_RUNTIME_LIFECYCLE.livenessSampleIntervalMs
    ),
    livenessSoftWarningMs: readMs(
      runtime?.livenessSoftWarningMs,
      env.MULTI_AGENT_LIVENESS_SOFT_WARNING_MS,
      DEFAULT_RUNTIME_LIFECYCLE.livenessSoftWarningMs
    ),
    livenessStallWarningMs: readMs(
      runtime?.livenessStallWarningMs,
      env.MULTI_AGENT_LIVENESS_STALL_WARNING_MS,
      DEFAULT_RUNTIME_LIFECYCLE.livenessStallWarningMs
    ),
    livenessBoundedExtensionFactor: factor
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
    const createLivenessProbe: (pid: number, config: LivenessProbeConfig) => ProcessLivenessProbe =
      this.dependencies.createLivenessProbe ??
      ((pid, config) => {
        const probeDeps: ProcessLivenessProbeDependencies = {
          now,
          setInterval: setIntervalImpl,
          clearInterval: clearIntervalImpl,
          platform
        };
        return new ProcessLivenessProbe(pid, config, probeDeps);
      });
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
    let stalled = false;
    let deadProcess = false;
    let fastFailed = false;
    let fastFailReason: string | null = null;
    let settled = false;
    let terminationStarted = false;
    let lastActivityMs = now();
    let lastActivityAt = new Date(lastActivityMs).toISOString();
    let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    let forceKillTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const probe =
      typeof child.pid === "number"
        ? createLivenessProbe(child.pid, {
            sampleIntervalMs: lifecycle.livenessSampleIntervalMs,
            softWarningMs: lifecycle.livenessSoftWarningMs,
            stallWarningMs: lifecycle.livenessStallWarningMs,
            boundedExtensionFactor: lifecycle.livenessBoundedExtensionFactor
          })
        : null;

    const clearTimers = () => {
      if (heartbeatTimer) {
        clearIntervalImpl(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      if (forceKillTimer) {
        clearTimeoutImpl(forceKillTimer);
        forceKillTimer = undefined;
      }

      probe?.stop();
    };

    // stdout = real activity (the CLI is producing output we can parse).
    // stderr = diagnostic noise; we forward it via hooks but don't treat it as activity,
    // because providers like Gemini spam stderr during 429 retry loops while effectively asleep.
    // The probe is what distinguishes "busy but silent" (extend timeout) from "idle and silent" (kill).
    const recordStdoutActivity = (chunk: string) => {
      lastActivityMs = now();
      lastActivityAt = new Date(lastActivityMs).toISOString();
      probe?.notifyActivity();
      hooks.onActivity?.({ stream: "stdout", at: lastActivityAt, chunk });
    };

    const forwardStderr = (chunk: string) => {
      // Deliberately NOT touching lastActivityMs here.
      hooks.onActivity?.({ stream: "stderr", at: new Date(now()).toISOString(), chunk });

      // Fast-fail 框架：runtime 通过覆写 classifyStderrChunk() 返回非 null 的
      // { reason } 即视为终止信号，立即 requestTermination。框架本身是通用能力，
      // 但 GeminiRuntime 已不再使用（F004/B006 第三版：retry 循环可自恢复，详见
      // gemini-runtime.ts 顶部注释）。如需新 runtime 启用，在子类覆写 classifyStderrChunk。
      if (!fastFailed && !terminationStarted) {
        const fastFail = this.classifyStderrChunk(chunk);
        if (fastFail) {
          fastFailed = true;
          fastFailReason = fastFail.reason;
          rawStderr = `${rawStderr.trimEnd() ? `${rawStderr.trimEnd()}\n` : ""}[runtime] ${formatFastFailMessage(fastFailReason)}\n`;
          requestTermination();
        }
      }
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
        recordStdoutActivity(line);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        rawStderr += text;
        hooks.onStderrChunk?.(text);
        forwardStderr(text);
      });

      child.on("error", (error) => {
        settle(() => reject(error));
      });

      child.on("close", (code) => {
        settle(() => {
          if (fastFailed) {
            reject(new Error(formatFastFailMessage(fastFailReason ?? "unknown")));
            return;
          }
          if (timedOut || stalled || deadProcess) {
            const reason = stalled ? "stall" : deadProcess ? "dead" : "timeout";
            reject(
              new Error(formatRuntimeTimeoutMessage(lifecycle.inactivityTimeoutMs, lastActivityAt, reason))
            );
            return;
          }

          resolve({
            finalText: this.extractFinalText(rawStdout),
            rawStdout,
            rawStderr,
            exitCode: cancelled && code === null ? 0 : code,
            stopReason: null
          });
        });
      });

      probe?.start();

      if (lifecycle.heartbeatIntervalMs > 0 && lifecycle.inactivityTimeoutMs > 0) {
        heartbeatTimer = setIntervalImpl(() => {
          if (terminationStarted) {
            return;
          }

          // Forward any liveness warnings the probe has queued since the last tick.
          if (probe) {
            for (const warning of probe.drainWarnings()) {
              hooks.onLivenessWarning?.(warning);
            }

            if (probe.getState() === "dead") {
              deadProcess = true;
              rawStderr = `${rawStderr.trimEnd() ? `${rawStderr.trimEnd()}\n` : ""}[runtime] ${formatRuntimeTimeoutMessage(lifecycle.inactivityTimeoutMs, lastActivityAt, "dead")}\n`;
              requestTermination();
              return;
            }
          }

          const elapsed = now() - lastActivityMs;

          // Fast-path: probe says the process is idle-silent long enough to be considered stuck.
          // Kill even if inactivityTimeoutMs hasn't elapsed yet — the CPU-flat signal is strong.
          // Windows path can only do PID-existence checks, so we can't trust its idle-silent
          // signal to differentiate "thinking" from "stuck" — leave the fast-path disabled there.
          if (
            probe &&
            probe.canClassifySilentState() &&
            elapsed >= lifecycle.livenessStallWarningMs &&
            probe.getState() === "idle-silent"
          ) {
            stalled = true;
            rawStderr = `${rawStderr.trimEnd() ? `${rawStderr.trimEnd()}\n` : ""}[runtime] ${formatRuntimeTimeoutMessage(lifecycle.livenessStallWarningMs, lastActivityAt, "stall")}\n`;
            requestTermination();
            return;
          }

          if (elapsed < lifecycle.inactivityTimeoutMs) {
            return;
          }

          // Busy-silent: CPU is growing, model is probably thinking. Extend up to the hard cap.
          if (
            probe &&
            probe.shouldExtendTimeout() &&
            !probe.isHardCapExceeded(elapsed, lifecycle.inactivityTimeoutMs)
          ) {
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

  /**
   * Provider-specific stderr scanner for "abort immediately" signatures. Return a reason
   * to force-kill the child; return null to let the process continue. Called on every
   * stderr chunk — match on keywords that indicate a terminal error the CLI is about to
   * waste multiple minutes retrying (Gemini 429 RESOURCE_EXHAUSTED retry loop).
   *
   * Public (not protected) so the message-service/test harness can drive it directly
   * when asserting per-provider patterns.
   */
  classifyStderrChunk(_chunk: string): { reason: string } | null {
    return null;
  }

  /**
   * Extract token usage from a single stream-json event.
   * Return `{ totalTokens, contextWindow }` whenever this event carries a usage summary.
   * Return null when the event is unrelated — the orchestrator will keep the last known
   * snapshot until a new one arrives.
   *
   * `contextWindow` is optional: when the CLI echoes it (Gemini's `stats.context_window`),
   * use it verbatim; when it doesn't (Codex/Claude typically don't), return null and let
   * the orchestrator fall back to the model-keyed lookup table.
   */
  parseUsage(_event: Record<string, unknown>): { totalTokens: number; contextWindow: number | null } | null {
    return null;
  }

  /**
   * Parse a terminal stop reason from a single stream-json event.
   * Return null when the event doesn't carry terminal info — cli-orchestrator keeps
   * the last non-null value seen during the turn. A turn that ends without any
   * terminal event (or a runtime that doesn't implement this) leaves the final
   * stopReason as null; downstream continuation logic treats null + exit0 + content
   * as "complete", and null + anything else as "aborted".
   */
  parseStopReason(_event: Record<string, unknown>): StopReason | null {
    return null;
  }

  /**
   * Extract the assistant's text delta from a single stream-json event.
   * Each runtime has its own event shape; returning "" means "not an assistant
   * text event" and is accumulated as no-op by the orchestrator.
   */
  parseAssistantDelta(_event: Record<string, unknown>): string {
    return "";
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

export function resolveNodeScript(
  packageName: string,
  relativeScriptPath: string[] | string[][],
  fallbackCommand?: string
) {
  const npmRoot = resolveNpmRoot();
  const candidatePaths = Array.isArray(relativeScriptPath[0])
    ? (relativeScriptPath as string[][])
    : [relativeScriptPath as string[]];
  const scriptPath = npmRoot
    ? candidatePaths
        .map((segments) => path.join(npmRoot, "node_modules", packageName, ...segments))
        .find((candidate) => existsSync(candidate)) ?? ""
    : "";

  if (scriptPath && existsSync(scriptPath)) {
    return {
      command: process.execPath,
      prefixArgs: [scriptPath],
      shell: false
    };
  }

  return {
    command: fallbackCommand ?? packageName,
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
