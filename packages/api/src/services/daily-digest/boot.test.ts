import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createDigestFetchImpl, isDigestEnabled } from "./boot"

describe("createDigestFetchImpl 代理凭证脱敏（德彪 P1r2）", () => {
  it("合法代理：日志只打 origin，凭证不入日志", () => {
    const logs: string[] = []
    const impl = createDigestFetchImpl("http://user:secret123@127.0.0.1:7897", (m) => logs.push(m))
    assert.ok(impl, "合法代理应返回 fetchImpl")
    assert.ok(logs.length > 0)
    for (const line of logs) {
      assert.ok(!line.includes("secret123"), `凭证泄露: ${line}`)
      assert.ok(!line.includes("user:"), `userinfo 泄露: ${line}`)
    }
  })

  it("malformed 带凭证代理：catch 分支同样不泄露原串（r2 finding 回归）", () => {
    const logs: string[] = []
    const impl = createDigestFetchImpl("http://user:secret123@", (m) => logs.push(m))
    assert.equal(impl, undefined)
    assert.ok(logs.length > 0, "应有一条『配置无效』日志")
    for (const line of logs) {
      assert.ok(!line.includes("secret123"), `凭证泄露: ${line}`)
    }
  })

  it("未配置代理 → undefined 且无日志", () => {
    const logs: string[] = []
    assert.equal(
      createDigestFetchImpl(undefined, (m) => logs.push(m)),
      undefined,
    )
    assert.equal(logs.length, 0)
  })
})

describe("isDigestEnabled（德彪 batchB-r1 P1：收件人任一来源即可）", () => {
  const CREDS = {
    MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
    MULTI_AGENT_DIGEST_SMTP_PASS: "p",
  } as NodeJS.ProcessEnv

  it("SMTP 在 .env + 收件人只在设置页 → 启用", () => {
    assert.equal(
      isDigestEnabled(CREDS, () => ({ recipients: ["a@x.com"] })),
      true,
    )
  })

  it("凭证齐但两边都没收件人 → 关；.env 有收件人 → 开", () => {
    assert.equal(
      isDigestEnabled(CREDS, () => undefined),
      false,
    )
    assert.equal(
      isDigestEnabled({ ...CREDS, MULTI_AGENT_DIGEST_TO: "a@x.com" }, () => undefined),
      true,
    )
  })

  it("flag 强开/强关盖过一切", () => {
    assert.equal(
      isDigestEnabled({ MULTI_AGENT_DIGEST_ENABLED: "1" } as NodeJS.ProcessEnv, () => undefined),
      true,
    )
    assert.equal(
      isDigestEnabled(
        { ...CREDS, MULTI_AGENT_DIGEST_ENABLED: "0", MULTI_AGENT_DIGEST_TO: "a@x.com" },
        () => ({ recipients: ["b@y.com"] }),
      ),
      false,
    )
  })
})
