import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import {
  bootDailyDigest,
  createDigestFetchImpl,
  evaluateDigestEnablement,
  isDigestEnabled,
  resolveDigestBootEnv,
  resolveDigestBootState,
} from "./boot"

const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), "b038-digest-env-"))
after(() => {
  fs.rmSync(envTmp, { recursive: true, force: true })
})

function writeDigestEnv(content: string): string {
  const target = path.join(envTmp, `.env-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(target, content, "utf8")
  return target
}

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

describe("resolveDigestBootEnv（B038：API 直启时只窄读日报前缀）", () => {
  it("只导入 MULTI_AGENT_DIGEST_*，支持 BOM/引号/值内等号，且不改入参", () => {
    const dotenvPath = writeDigestEnv(
      [
        "\uFEFFMULTI_AGENT_DIGEST_SMTP_USER=from-file@qq.com",
        'MULTI_AGENT_DIGEST_SMTP_PASS="secret=with=equals"',
        "MULTI_AGENT_DIGEST_TO='a@example.com,b@example.com'",
        "CORS_ORIGIN=http://should-not-leak.example",
        "FEISHU_APP_SECRET=should-not-leak",
      ].join("\n"),
    )
    const processEnv = { PATH: "safe-path" } as NodeJS.ProcessEnv
    const before = { ...processEnv }

    const resolved = resolveDigestBootEnv(processEnv, dotenvPath)

    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_USER, "from-file@qq.com")
    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_PASS, "secret=with=equals")
    assert.equal(resolved.MULTI_AGENT_DIGEST_TO, "a@example.com,b@example.com")
    assert.equal(resolved.PATH, "safe-path", "原进程环境仍须保留给 PATH/HTTPS_PROXY 等依赖")
    assert.equal(resolved.CORS_ORIGIN, undefined, "非日报文件变量不得泄入 API 环境")
    assert.equal(resolved.FEISHU_APP_SECRET, undefined, "非日报文件变量不得泄入 API 环境")
    assert.deepEqual(processEnv, before, "解析器不得修改调用方 process env")
  })

  it("支持 dotenv 行内注释与 export；引号内 # 必须保留", () => {
    const dotenvPath = writeDigestEnv(
      [
        'export MULTI_AGENT_DIGEST_SMTP_USER="quoted#user@qq.com" # human note',
        "MULTI_AGENT_DIGEST_SMTP_PASS=plain-pass # human note",
        "MULTI_AGENT_DIGEST_TO='tag#inside@example.com' # human note",
        "MULTI_AGENT_DIGEST_ENABLED=1#human-note",
      ].join("\n"),
    )

    const resolved = resolveDigestBootEnv({}, dotenvPath)

    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_USER, "quoted#user@qq.com")
    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_PASS, "plain-pass")
    assert.equal(resolved.MULTI_AGENT_DIGEST_TO, "tag#inside@example.com")
    assert.equal(resolved.MULTI_AGENT_DIGEST_ENABLED, "1")
  })

  it("process env 按键存在即覆盖文件：显式 0 与空值都不能被文件洗回", () => {
    const dotenvPath = writeDigestEnv(
      [
        "MULTI_AGENT_DIGEST_ENABLED=1",
        "MULTI_AGENT_DIGEST_SMTP_USER=file@qq.com",
        "MULTI_AGENT_DIGEST_SMTP_PASS=file-pass",
        "MULTI_AGENT_DIGEST_TO=file@example.com",
      ].join("\n"),
    )

    const resolved = resolveDigestBootEnv(
      {
        MULTI_AGENT_DIGEST_ENABLED: "0",
        MULTI_AGENT_DIGEST_SMTP_USER: "",
      } as NodeJS.ProcessEnv,
      dotenvPath,
    )

    assert.equal(resolved.MULTI_AGENT_DIGEST_ENABLED, "0")
    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_USER, "")
    assert.equal(resolved.MULTI_AGENT_DIGEST_SMTP_PASS, "file-pass")
    assert.equal(resolved.MULTI_AGENT_DIGEST_TO, "file@example.com")
  })

  it("文件不存在/不可读时 fail-soft，只返回 process env 快照", () => {
    const processEnv = { MULTI_AGENT_DIGEST_ENABLED: "0" } as NodeJS.ProcessEnv
    const resolved = resolveDigestBootEnv(processEnv, path.join(envTmp, "missing.env"))
    assert.notEqual(resolved, processEnv)
    assert.deepEqual(resolved, processEnv)
  })
})

describe("evaluateDigestEnablement（B038：固定安全原因码）", () => {
  const CREDS = {
    MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
    MULTI_AGENT_DIGEST_SMTP_PASS: "secret-do-not-log",
    MULTI_AGENT_DIGEST_TO: "a@example.com",
  } as NodeJS.ProcessEnv

  it("显式强开/强关优先于凭证", () => {
    assert.deepEqual(evaluateDigestEnablement({ MULTI_AGENT_DIGEST_ENABLED: "1" }), {
      enabled: true,
      reason: "explicit_on",
    })
    assert.deepEqual(evaluateDigestEnablement({ ...CREDS, MULTI_AGENT_DIGEST_ENABLED: "0" }), {
      enabled: false,
      reason: "explicit_off",
    })
  })

  it("完整 SMTP + 任一收件人来源为 smtp_ready", () => {
    assert.deepEqual(
      evaluateDigestEnablement(CREDS, () => undefined),
      {
        enabled: true,
        reason: "smtp_ready",
      },
    )
    assert.deepEqual(
      evaluateDigestEnablement(
        {
          MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
          MULTI_AGENT_DIGEST_SMTP_PASS: "p",
        },
        () => ({ recipients: ["settings@example.com"] }),
      ),
      { enabled: true, reason: "smtp_ready" },
    )
  })

  it("缺字段逐项给固定原因码，不包含任何配置值", () => {
    const cases = [
      [{}, "missing_user"],
      [{ MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com" }, "missing_pass"],
      [
        {
          MULTI_AGENT_DIGEST_SMTP_USER: "u@qq.com",
          MULTI_AGENT_DIGEST_SMTP_PASS: "secret-do-not-log",
        },
        "missing_recipient",
      ],
    ] as const

    for (const [env, reason] of cases) {
      const decision = evaluateDigestEnablement(env as NodeJS.ProcessEnv, () => undefined)
      assert.deepEqual(decision, { enabled: false, reason })
      assert.ok(!JSON.stringify(decision).includes("secret-do-not-log"))
      assert.ok(!JSON.stringify(decision).includes("u@qq.com"))
    }
  })
})

describe("resolveDigestBootState（B038：生产装配只消费一个终态快照）", () => {
  it("文件补齐凭证后，返回的 env 与 decision 同源且可供 sender/routes 复用", () => {
    const rootDir = fs.mkdtempSync(path.join(envTmp, "root-"))
    fs.writeFileSync(
      path.join(rootDir, ".env"),
      [
        "MULTI_AGENT_DIGEST_SMTP_USER=file@qq.com",
        "MULTI_AGENT_DIGEST_SMTP_PASS=file-pass",
        "MULTI_AGENT_DIGEST_TO=file@example.com",
      ].join("\n"),
      "utf8",
    )

    const state = resolveDigestBootState({ PATH: "safe" }, rootDir, () => undefined)

    assert.deepEqual(state.decision, { enabled: true, reason: "smtp_ready" })
    assert.equal(state.env.MULTI_AGENT_DIGEST_SMTP_USER, "file@qq.com")
    assert.equal(state.env.MULTI_AGENT_DIGEST_SMTP_PASS, "file-pass")
    assert.equal(state.env.MULTI_AGENT_DIGEST_TO, "file@example.com")
  })

  it("process 显式 0 在终态快照与 decision 中一致保持关闭", () => {
    const rootDir = fs.mkdtempSync(path.join(envTmp, "root-off-"))
    fs.writeFileSync(
      path.join(rootDir, ".env"),
      [
        "MULTI_AGENT_DIGEST_ENABLED=1",
        "MULTI_AGENT_DIGEST_SMTP_USER=file@qq.com",
        "MULTI_AGENT_DIGEST_SMTP_PASS=file-pass",
        "MULTI_AGENT_DIGEST_TO=file@example.com",
      ].join("\n"),
      "utf8",
    )

    const state = resolveDigestBootState(
      { MULTI_AGENT_DIGEST_ENABLED: "0" },
      rootDir,
      () => undefined,
    )

    assert.equal(state.env.MULTI_AGENT_DIGEST_ENABLED, "0")
    assert.deepEqual(state.decision, { enabled: false, reason: "explicit_off" })
  })

  it("bootDailyDigest 默认使用同一路径快照，文件凭证不得退化成 mock sender", () => {
    const rootDir = fs.mkdtempSync(path.join(envTmp, "root-sender-"))
    fs.writeFileSync(
      path.join(rootDir, ".env"),
      [
        "MULTI_AGENT_DIGEST_SMTP_USER=file@qq.com",
        "MULTI_AGENT_DIGEST_SMTP_PASS=file-pass",
        "MULTI_AGENT_DIGEST_TO=file@example.com",
      ].join("\n"),
      "utf8",
    )

    const runtime = bootDailyDigest({ rootDir, loadSettings: () => undefined })

    assert.equal(runtime.senderKind, "qq-smtp")
  })
})
