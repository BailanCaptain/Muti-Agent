import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { prepareAgentFile } from "./agent-file"

const genId = () => "abcdef1234567890"
const now = () => 1700000000000

describe("prepareAgentFile（send_file 落盘策略纯核）", () => {
  it("常规文本扩展名保留；存储名 = agent-<ts>-<8位随机><ext>", () => {
    const r = prepareAgentFile("report.md", genId, now)
    assert.equal(r.displayName, "report.md")
    assert.equal(r.storedName, "agent-1700000000000-abcdef12.md")
  })

  it("路径穿越被斩段（../ / 反斜杠 / 盘符；posix/win 行为一致）", () => {
    assert.equal(prepareAgentFile("../../etc/passwd", genId, now).displayName, "passwd.txt")
    assert.equal(prepareAgentFile("..\\..\\boot.ini", genId, now).displayName, "boot.txt")
    assert.equal(prepareAgentFile("C:\\Windows\\evil.md", genId, now).displayName, "evil.md")
  })

  it("白名单外扩展名回落 .txt（exe/bin/无扩展名）；大写扩展名归一小写", () => {
    assert.equal(prepareAgentFile("payload.exe", genId, now).displayName, "payload.txt")
    assert.equal(prepareAgentFile("noext", genId, now).displayName, "noext.txt")
    assert.equal(prepareAgentFile("README.MD", genId, now).displayName, "README.md")
    assert.ok(prepareAgentFile("payload.exe", genId, now).storedName.endsWith(".txt"))
  })

  it("T7 修8（德彪 r7 P1）：html/htm 除名回落 .txt——跨源导航 download 属性失效，网页文件不当可执行文档发", () => {
    assert.equal(prepareAgentFile("report.html", genId, now).displayName, "report.txt")
    assert.equal(prepareAgentFile("page.HTM", genId, now).displayName, "page.txt")
    assert.ok(prepareAgentFile("report.html", genId, now).storedName.endsWith(".txt"))
  })

  it("空/未给文件名 → attachment.txt；空白与控制符收敛下划线", () => {
    assert.equal(prepareAgentFile(undefined, genId, now).displayName, "attachment.txt")
    assert.equal(prepareAgentFile("   ", genId, now).displayName, "attachment.txt")
    assert.equal(
      prepareAgentFile("my report final.txt", genId, now).displayName,
      "my_report_final.txt",
    )
  })
})
