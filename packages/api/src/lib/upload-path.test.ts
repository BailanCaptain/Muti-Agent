import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"
import { containedUploadPath, uploadBasename } from "./upload-path"

describe("uploadBasename（T7 修10 · 德彪 r7 P2）", () => {
  it("合法单层名通过", () => {
    assert.equal(uploadBasename("/uploads/feishu-x.png"), "feishu-x.png")
    assert.equal(
      uploadBasename("/uploads/agent-1700000000000-abcdef12.txt"),
      "agent-1700000000000-abcdef12.txt",
    )
  })

  it("dot-segment 拒（basename+resolve 会逃容器：/uploads/.. → 父目录）", () => {
    assert.equal(uploadBasename("/uploads/."), null)
    assert.equal(uploadBasename("/uploads/.."), null)
  })

  it("子路径/反斜杠/冒号（win32 驱动器相对）/非前缀/空名拒", () => {
    assert.equal(uploadBasename("/uploads/a/b.png"), null)
    assert.equal(uploadBasename("/uploads/sub\\x.png"), null)
    assert.equal(uploadBasename("/uploads/C:pwn.txt"), null)
    assert.equal(uploadBasename("/etc/passwd"), null)
    assert.equal(uploadBasename("/uploads/"), null)
    assert.equal(uploadBasename("uploads/x.png"), null)
  })

  it("编码 dot 不解码 = 字面文件名（fs 无二次解码，无穿越面）", () => {
    assert.equal(uploadBasename("/uploads/%2e%2e"), "%2e%2e")
  })
})

describe("containedUploadPath", () => {
  const root = path.resolve(path.join("data", "uploads"))

  it("常规名解析进容器", () => {
    assert.equal(containedUploadPath(root, "a.png"), path.join(root, "a.png"))
  })

  it("dot-segment 兜底拒（双保险；正常已被 uploadBasename 先挡）", () => {
    assert.equal(containedUploadPath(root, ".."), null)
    assert.equal(containedUploadPath(root, "."), null)
  })
})
