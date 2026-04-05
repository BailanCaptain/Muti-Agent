import { execFile } from "node:child_process";

/**
 * CPU-based liveness classification for CLI child processes.
 *
 * Motivation: Gemini CLI's internal retry loop (10 attempts, 5-30s backoff on 429)
 * floods stderr with retry messages while the process itself is sleeping. If we use
 * stderr output to keep the inactivity timer alive, a genuinely stuck/sleeping CLI
 * will hold the turn open for ~4 minutes before anything upstream notices.
 *
 * This probe distinguishes four states by sampling the child's CPU time:
 *   - active:      output seen within sampleIntervalMs
 *   - busy-silent: no output, but CPU time growing → model is thinking, keep alive
 *   - idle-silent: no output AND CPU flat → process is sleeping/stuck → kill
 *   - dead:        PID no longer exists
 *
 * Windows fallback: `ps` is not available, so we only do PID-existence checks and
 * conservatively treat all silence as idle-silent. This is strictly a regression on
 * Windows (a thinking model gets killed), but combined with bounded-extension logic
 * upstream it still behaves better than our current stderr-driven timer.
 */

export type LivenessState = "active" | "busy-silent" | "idle-silent" | "dead";

export type LivenessWarningLevel = "alive_but_silent" | "suspected_stall";

export type LivenessWarning = {
  state: LivenessState;
  level: LivenessWarningLevel;
  silenceDurationMs: number;
  cpuTimeMs: number;
  processAlive: boolean;
};

export type LivenessProbeConfig = {
  /** How often to sample CPU time (ms). Default 60s — long enough that normal CLI idle periods don't noise the log. */
  sampleIntervalMs: number;
  /** Soft warning threshold (ms of silence). Emits alive_but_silent warning. Default 120s. */
  softWarningMs: number;
  /** Stall threshold (ms of silence). Emits suspected_stall warning. Default 180s. */
  stallWarningMs: number;
  /** Bounded extension factor for busy-silent state (elapsed allowed up to factor * timeoutMs). Default 2.0. */
  boundedExtensionFactor: number;
};

const DEFAULT_CONFIG: LivenessProbeConfig = {
  sampleIntervalMs: 60_000,
  softWarningMs: 120_000,
  stallWarningMs: 180_000,
  boundedExtensionFactor: 2.0
};

/** Parse `ps -o cputime=` output (h:mm:ss or mm:ss.SS) to milliseconds. */
export function parseCpuTime(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 0;
  }

  const parts = trimmed.split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  }

  if (parts.length === 2) {
    const [m, s] = parts;
    return (Number(m) * 60 + Number(s)) * 1000;
  }

  return 0;
}

export type ProcessLivenessProbeDependencies = {
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  platform?: NodeJS.Platform;
  /** PID existence check. Returns true if pid is alive. */
  isPidAlive?: (pid: number) => boolean;
  /** Unix CPU sampler — resolves to milliseconds of CPU time. Rejects if the pid is gone. */
  sampleCpuTime?: (pid: number) => Promise<number>;
};

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSampleCpuTime(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "cputime=", "-p", String(pid)], (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(parseCpuTime(stdout));
    });
  });
}

export class ProcessLivenessProbe {
  readonly config: LivenessProbeConfig;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly platform: NodeJS.Platform;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly sampleCpuTime: (pid: number) => Promise<number>;

  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private lastActivityAt: number;
  private currCpuTimeMs = 0;
  private prevCpuTimeMs = 0;
  private cpuGrowing = false;
  private pidAlive = true;
  private stopped = false;
  private warningQueue: LivenessWarning[] = [];
  private softWarningEmitted = false;
  private stallWarningEmitted = false;

  constructor(
    pid: number,
    config: Partial<LivenessProbeConfig> = {},
    deps: ProcessLivenessProbeDependencies = {}
  ) {
    this.pid = pid;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = deps.now ?? Date.now;
    this.setIntervalImpl = deps.setInterval ?? globalThis.setInterval;
    this.clearIntervalImpl = deps.clearInterval ?? globalThis.clearInterval;
    this.platform = deps.platform ?? process.platform;
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.sampleCpuTime = deps.sampleCpuTime ?? defaultSampleCpuTime;
    this.lastActivityAt = this.now();
  }

  /** Notify the probe that output was received. Resets silence tracking. */
  notifyActivity(): void {
    this.lastActivityAt = this.now();
    this.softWarningEmitted = false;
    this.stallWarningEmitted = false;
  }

  getState(): LivenessState {
    if (!this.pidAlive) {
      return "dead";
    }
    const silenceMs = this.now() - this.lastActivityAt;
    if (silenceMs < this.config.sampleIntervalMs) {
      return "active";
    }
    return this.cpuGrowing ? "busy-silent" : "idle-silent";
  }

  /** True if the current state warrants extending the inactivity timeout. */
  shouldExtendTimeout(): boolean {
    return this.getState() === "busy-silent";
  }

  /**
   * Whether this probe can reliably distinguish idle-silent from busy-silent on the current platform.
   * Unix has CPU sampling via `ps`. Windows only has PID-existence checks, so any "silent" state is
   * flagged as idle-silent and should NOT be used to fast-path kill a process.
   */
  canClassifySilentState(): boolean {
    return this.platform !== "win32";
  }

  /** True if elapsed time has already passed the bounded extension cap. */
  isHardCapExceeded(elapsedMs: number, timeoutMs: number): boolean {
    return elapsedMs >= this.config.boundedExtensionFactor * timeoutMs;
  }

  /** Pull and clear pending warnings. */
  drainWarnings(): LivenessWarning[] {
    return this.warningQueue.splice(0);
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    // Run the first sample immediately so `getState()` can report something useful before the first tick.
    void this.sampleOnce();
    this.timer = this.setIntervalImpl(() => {
      void this.sampleOnce();
    }, this.config.sampleIntervalMs);
    // setInterval returns Timeout on node; .unref exists on it.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
  }

  private async sampleOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (!this.isPidAlive(this.pid)) {
      this.pidAlive = false;
      return;
    }

    // Windows: no `ps`. We can only verify PID existence. Treat silence as idle so stall detection still fires.
    if (this.platform === "win32") {
      this.cpuGrowing = false;
      this.emitSilenceWarnings();
      return;
    }

    try {
      const nextCpuMs = await this.sampleCpuTime(this.pid);
      this.prevCpuTimeMs = this.currCpuTimeMs;
      this.currCpuTimeMs = nextCpuMs;
      this.cpuGrowing = this.currCpuTimeMs > this.prevCpuTimeMs;
    } catch {
      // ps failed — process likely gone between isPidAlive() and here.
      this.pidAlive = false;
      return;
    }

    this.emitSilenceWarnings();
  }

  private emitSilenceWarnings(): void {
    const silenceMs = this.now() - this.lastActivityAt;
    if (silenceMs >= this.config.stallWarningMs && !this.stallWarningEmitted) {
      this.stallWarningEmitted = true;
      this.warningQueue.push(this.makeWarning("suspected_stall", silenceMs));
      return;
    }

    if (silenceMs >= this.config.softWarningMs && !this.softWarningEmitted) {
      this.softWarningEmitted = true;
      this.warningQueue.push(this.makeWarning("alive_but_silent", silenceMs));
    }
  }

  private makeWarning(level: LivenessWarningLevel, silenceDurationMs: number): LivenessWarning {
    return {
      state: this.getState(),
      level,
      silenceDurationMs,
      cpuTimeMs: this.currCpuTimeMs,
      processAlive: this.pidAlive
    };
  }
}
