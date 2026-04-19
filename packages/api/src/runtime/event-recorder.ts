/**
 * Event Recorder — captures raw NDJSON events + classification results.
 * Activate: set RECORD_EVENTS=1 in .env or shell.
 * Output: docs/runtime-events/<provider>-<timestamp>.ndjson
 *
 * Each line is a JSON object with:
 *   { ts, stream, raw?, classified?, line?, chunk? }
 *
 * After recording, analyze with:
 *   node -e "require('fs').readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse).forEach(e => console.log(e.stream, e.classified?.toolEvent ? 'TOOL' : e.classified?.activity ? 'THINK' : e.classified?.delta ? 'DELTA' : 'OTHER'))"
 */
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "@multi-agent/shared";

export function createEventRecorder(provider: Provider): {
  record: (entry: Record<string, unknown>) => void;
  filePath: string | null;
} {
  if (!process.env.RECORD_EVENTS) {
    return { record: () => {}, filePath: null };
  }

  const dir =
    process.env.RUNTIME_EVENTS_DIR ??
    path.join(process.cwd(), ".runtime", "runtime-events");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${provider}-${ts}.ndjson`);

  fs.writeFileSync(
    filePath,
    JSON.stringify({ meta: true, provider, startedAt: new Date().toISOString() }) + "\n",
  );

  return {
    filePath,
    record(entry: Record<string, unknown>) {
      try {
        fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
      } catch {
        /* best-effort — don't crash the runtime */
      }
    },
  };
}
