import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveDigestEnv } from "./email-sender"

describe("resolveDigestEnv", () => {
  it("读 MULTI_AGENT_DIGEST_* 变量", () => {
    const cfg = resolveDigestEnv({
      MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
      MULTI_AGENT_DIGEST_SMTP_PASS: "p",
      MULTI_AGENT_DIGEST_TO: "t@gmail.com",
    } as NodeJS.ProcessEnv)
    assert.equal(cfg.smtpUser, "u@qq.com")
    assert.equal(cfg.to, "t@gmail.com")
    assert.equal(cfg.githubPat, undefined)
  })
})
