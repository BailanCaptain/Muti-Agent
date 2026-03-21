import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  awaitRunsToStop,
  registerGracefulShutdown,
  type ActiveRuntimeRun,
  type ProcessSignalHost
} from "./shutdown";

type FakeProcessHost = EventEmitter &
  ProcessSignalHost & {
    emit: (eventName: NodeJS.Signals) => boolean;
  };

test("awaitRunsToStop cancels every active run and waits for completion", async () => {
  const calls: string[] = [];
  const runs: ActiveRuntimeRun[] = [
    {
      cancel() {
        calls.push("cancel-1");
      },
      promise: delay(5).then(() => {
        calls.push("done-1");
      })
    },
    {
      cancel() {
        calls.push("cancel-2");
      },
      promise: delay(1).then(() => {
        calls.push("done-2");
      })
    }
  ];

  await awaitRunsToStop(runs);
  assert.deepEqual(calls, ["cancel-1", "cancel-2", "done-2", "done-1"]);
});

test("registerGracefulShutdown closes only once when a process signal arrives", async () => {
  const host = new EventEmitter() as unknown as FakeProcessHost;
  let closeCalls = 0;

  registerGracefulShutdown({
    processHost: host,
    close: async () => {
      closeCalls += 1;
    }
  });

  host.emit("SIGTERM");
  host.emit("SIGINT");
  await delay(0);

  assert.equal(closeCalls, 1);
  assert.equal(host.exitCode, 143);
});
