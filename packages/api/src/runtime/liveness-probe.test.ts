import assert from "node:assert/strict";
import test from "node:test";
import { ProcessLivenessProbe, parseCpuTime, parseCpuTimeSeconds } from "./liveness-probe";

test("parseCpuTime handles h:mm:ss and mm:ss.SS formats", () => {
  assert.equal(parseCpuTime(""), 0);
  assert.equal(parseCpuTime("00:12.50"), 12_500);
  assert.equal(parseCpuTime("01:00.00"), 60_000);
  assert.equal(parseCpuTime("1:02:03"), (3600 + 2 * 60 + 3) * 1000);
});

type FakeClock = {
  now: () => number;
  tick: (ms: number) => void;
};

function createFakeClock(startAt = 1_000_000): FakeClock {
  let time = startAt;
  return {
    now: () => time,
    tick(ms: number) {
      time += ms;
    }
  };
}

function createProbe(
  options: {
    platform?: NodeJS.Platform;
    cpuSamples?: number[];
    pidAlive?: boolean;
  } = {}
) {
  const clock = createFakeClock();
  const samples = options.cpuSamples ?? [];
  let index = 0;
  let pidAlive = options.pidAlive ?? true;
  const probe = new ProcessLivenessProbe(
    1234,
    {
      sampleIntervalMs: 100,
      softWarningMs: 200,
      stallWarningMs: 300,
      boundedExtensionFactor: 2
    },
    {
      now: clock.now,
      // No-op timers — the test drives sampling manually via private access.
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
      platform: options.platform ?? "linux",
      isPidAlive: () => pidAlive,
      sampleCpuTime: async () => {
        const next = samples[Math.min(index, samples.length - 1)] ?? 0;
        index += 1;
        return next;
      }
    }
  );
  return {
    probe,
    clock,
    killPid() {
      pidAlive = false;
    },
    async sampleOnce() {
      // Trigger a sample via the public `start()` + direct sample call.
      // Easiest: call the private sampleOnce via bracket access.
      await (probe as unknown as { sampleOnce: () => Promise<void> }).sampleOnce();
    }
  };
}

test("initial state is active within sampleIntervalMs", () => {
  const { probe } = createProbe();
  assert.equal(probe.getState(), "active");
});

test("CPU growing between samples → busy-silent after silence", async () => {
  const { probe, clock, sampleOnce } = createProbe({ cpuSamples: [100, 250, 500] });
  await sampleOnce();
  clock.tick(150); // past sampleIntervalMs
  await sampleOnce();
  assert.equal(probe.getState(), "busy-silent");
  assert.equal(probe.shouldExtendTimeout(), true);
});

test("CPU flat between samples → idle-silent after silence", async () => {
  const { probe, clock, sampleOnce } = createProbe({ cpuSamples: [500, 500, 500] });
  await sampleOnce();
  clock.tick(150);
  await sampleOnce();
  assert.equal(probe.getState(), "idle-silent");
  assert.equal(probe.shouldExtendTimeout(), false);
});

test("notifyActivity resets state to active", async () => {
  const { probe, clock, sampleOnce } = createProbe({ cpuSamples: [0, 0] });
  clock.tick(150);
  await sampleOnce();
  assert.equal(probe.getState(), "idle-silent");
  probe.notifyActivity();
  assert.equal(probe.getState(), "active");
});

test("emits alive_but_silent at softWarningMs then suspected_stall at stallWarningMs", async () => {
  const { probe, clock, sampleOnce } = createProbe({ cpuSamples: [0, 0, 0, 0] });
  clock.tick(210); // past softWarningMs (200)
  await sampleOnce();
  const soft = probe.drainWarnings();
  assert.equal(soft.length, 1);
  assert.equal(soft[0].level, "alive_but_silent");
  assert.equal(soft[0].state, "idle-silent");

  clock.tick(100); // now at 310, past stallWarningMs (300)
  await sampleOnce();
  const stall = probe.drainWarnings();
  assert.equal(stall.length, 1);
  assert.equal(stall[0].level, "suspected_stall");
});

test("notifyActivity rearms warning emission", async () => {
  const { probe, clock, sampleOnce } = createProbe({ cpuSamples: [0, 0, 0] });
  clock.tick(310);
  await sampleOnce();
  assert.equal(probe.drainWarnings().length, 1); // suspected_stall fires first (covers both thresholds)

  probe.notifyActivity();
  clock.tick(210);
  await sampleOnce();
  const second = probe.drainWarnings();
  assert.equal(second.length, 1);
  assert.equal(second[0].level, "alive_but_silent");
});

test("dead PID flips state to dead and stops sampling CPU", async () => {
  const { probe, sampleOnce, killPid } = createProbe({ cpuSamples: [100] });
  killPid();
  await sampleOnce();
  assert.equal(probe.getState(), "dead");
  assert.equal(probe.shouldExtendTimeout(), false);
});

test("win32 platform uses CPU sampling (growing CPU → busy-silent)", async () => {
  const { probe, clock, sampleOnce } = createProbe({ platform: "win32", cpuSamples: [999, 999] });
  await sampleOnce();    // prev=0 → curr=999, growing
  clock.tick(150);
  await sampleOnce();    // prev=999 → curr=999, flat (but first sample made it grow)
  // cpuGrowing reflects the LAST delta: 999→999 = flat → idle-silent
  assert.equal(probe.getState(), "idle-silent");
});

test("isHardCapExceeded compares elapsed against factor * timeout", () => {
  const { probe } = createProbe();
  assert.equal(probe.isHardCapExceeded(100, 100), false);
  assert.equal(probe.isHardCapExceeded(199, 100), false);
  assert.equal(probe.isHardCapExceeded(200, 100), true);
});

// B010: Windows CPU sampling via PowerShell Get-Process
test("parseCpuTimeSeconds converts PowerShell float seconds to milliseconds", () => {
  assert.equal(parseCpuTimeSeconds(""), 0);
  assert.equal(parseCpuTimeSeconds("1.234"), 1234);
  assert.equal(parseCpuTimeSeconds("0.5"), 500);
  assert.equal(parseCpuTimeSeconds("60"), 60_000);
  assert.equal(parseCpuTimeSeconds("   2.5\n"), 2500);
});

test("win32 with growing CPU → busy-silent (B010: CPU sampling now works on Windows)", async () => {
  const { probe, clock, sampleOnce } = createProbe({ platform: "win32", cpuSamples: [100, 250] });
  await sampleOnce();       // prev=0 → curr=100, growing
  clock.tick(150);          // past sampleIntervalMs
  await sampleOnce();       // prev=100 → curr=250, growing
  assert.equal(probe.getState(), "busy-silent");
  assert.equal(probe.shouldExtendTimeout(), true);
});

test("win32 with flat CPU → idle-silent (B010: proper classification)", async () => {
  const { probe, clock, sampleOnce } = createProbe({ platform: "win32", cpuSamples: [100, 100, 100] });
  await sampleOnce();       // prev=0 → curr=100, growing
  clock.tick(150);
  await sampleOnce();       // prev=100 → curr=100, flat
  assert.equal(probe.getState(), "idle-silent");
  assert.equal(probe.shouldExtendTimeout(), false);
});

test("canClassifySilentState returns true on win32 (B010)", () => {
  const { probe } = createProbe({ platform: "win32" });
  assert.equal(probe.canClassifySilentState(), true);
});
