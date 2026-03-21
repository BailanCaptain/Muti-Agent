export type ActiveRuntimeRun = {
  cancel: () => void;
  promise: Promise<unknown>;
};

export type ProcessSignalHost = Pick<NodeJS.Process, "once"> & {
  exitCode?: number;
};

function signalExitCode(signal: NodeJS.Signals) {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

export async function awaitRunsToStop(runs: Iterable<ActiveRuntimeRun>) {
  const pending = Array.from(runs, async (run) => {
    run.cancel();
    await run.promise.catch(() => undefined);
  });

  await Promise.allSettled(pending);
}

export function registerGracefulShutdown(options: {
  close: () => Promise<void> | void;
  processHost?: ProcessSignalHost;
  signals?: NodeJS.Signals[];
}) {
  const processHost = options.processHost ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  let shuttingDown = false;

  for (const signal of signals) {
    processHost.once(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      processHost.exitCode = signalExitCode(signal);
      void Promise.resolve(options.close()).catch(() => undefined);
    });
  }
}
