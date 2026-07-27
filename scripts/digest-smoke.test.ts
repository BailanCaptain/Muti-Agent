import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import test from "node:test"

test("B045：真网 smoke 与活跃常驻源一致，不再旁路运行 Digg，并覆盖 GitHub 四榜", () => {
  const scriptPath = path.join(process.cwd(), "scripts", "digest-smoke.ts")
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.doesNotMatch(script, /\bmakeDiggAiSource\b/)
  assert.doesNotMatch(
    script,
    /services\/daily-digest\/safe-http-client/,
    "smoke 不得引用已迁移后不存在的 SafeHTTP 路径",
  )
  assert.match(script, /packages\/api\/src\/net\/safe-http-client/)
  assert.match(script, /\bmakeGithubDailySource\b/)
  assert.match(script, /\bmakeGithubWeeklySource\b/)
  assert.match(script, /\bmakeGithubNewcomersSource\b/)
  assert.match(script, /\bmakeGithubMonthlySource\b/)

  for (const [, specifier] of script.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = path.resolve(path.dirname(scriptPath), specifier)
    assert.ok(
      fs.existsSync(target) || fs.existsSync(`${target}.ts`) || fs.existsSync(path.join(target, "index.ts")),
      `smoke 相对 import 必须可解析：${specifier}`,
    )
  }
})
