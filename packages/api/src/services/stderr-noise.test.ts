import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterStderrNoise } from "./message-service";

describe("filterStderrNoise — Gemini CLI GaxiosError/TLS stack filtering (F012 AC-20)", () => {
  it("strips the full GaxiosError block from Gemini refreshAuth stderr", () => {
    const sample = `Failed to fetch experiments _GaxiosError: request to https://cloudcode-pa.googleapis.com/v1internal:listExperiments failed, reason: Client network socket disconnected before secure TLS connection was established
    at Gaxios._request (file:///C:/Users/-/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk-IWSCP2GY.js:8582:66)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async _OAuth2Client.requestAsync (file:///.../chunk-IWSCP2GY.js:10541:16)
    at async main (file:///.../gemini.js:14959:9) {
  config: {
    proxy: 'http://127.0.0.1:7897',
    url: 'https://cloudcode-pa.googleapis.com/v1internal:listExperiments',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: '<<REDACTED>>'
    },
    retryConfig: {
      retryDelay: 100,
      retry: 3,
      timeOfFirstRequest: 1776520597668
    },
    paramsSerializer: [Function: paramsSerializer],
    agent: HttpsProxyAgent {
      _events: [Object: null prototype],
      proxy: URL {},
      Symbol(kCapture): false
    }
  },
  response: undefined,
  error: FetchError2: request to https://... failed {
    type: 'system',
    errno: 'ECONNRESET',
    code: 'ECONNRESET'
  },
  code: 'ECONNRESET',
  Symbol(gaxios-gaxios-error): '6.7.1'
}`;

    const out = filterStderrNoise(sample);
    // The whole block is noise — after filtering, nothing meaningful should remain.
    assert.equal(out.trim(), "");
  });

  it("keeps a genuine user-facing stderr message through", () => {
    const sample = "Agent: this is a real user-visible message\n";
    const out = filterStderrNoise(sample);
    assert.match(out, /Agent: this is a real user-visible message/);
  });

  it("still filters previously-known noise (YOLO, [runtime], etc)", () => {
    const sample = `YOLO mode is enabled
[runtime] something
Using model: gemini-2.5-pro
All tool calls will be automatically approved`;
    assert.equal(filterStderrNoise(sample).trim(), "");
  });
});
