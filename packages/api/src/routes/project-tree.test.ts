import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import Fastify from "fastify"

import { registerProjectTreeRoutes } from "./project-tree"

/** F028 Task 14 · project-tree 路由（roots/list/content 透传 + 400/404 分流） */

async function makeApp() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-ptroute-"))
  const main = path.join(base, "repo")
  await fs.mkdir(path.join(main, "src"), { recursive: true })
  await fs.mkdir(path.join(main, "data"), { recursive: true })
  await fs.writeFile(path.join(main, "src", "a.ts"), "export {}", "utf8")
  await fs.writeFile(path.join(main, "src", "bin.dat"), Buffer.from([0x00, 0x01]))
  await fs.writeFile(path.join(main, ".env"), "S=1", "utf8")
  await fs.writeFile(path.join(main, "data", "prod.sqlite"), "DB", "utf8")

  const app = Fastify({ logger: false })
  registerProjectTreeRoutes(app, {
    mainRepoRoot: main,
    inventory: async () => [
      { name: "main", branch: "dev", head: "a", path: main, isMain: true, preview: null, mergeStatus: null },
    ],
  })
  await app.ready()
  return app
}

test("F028 T14 · roots/list/content happy paths", async () => {
  const app = await makeApp()
  const roots = await app.inject({ method: "GET", url: "/api/project-tree/roots" })
  assert.equal(roots.statusCode, 200)
  assert.deepEqual(roots.json().roots[0], { id: "main", label: "主仓" })

  const list = await app.inject({ method: "GET", url: "/api/project-tree/list?root=main&dir=src" })
  assert.equal(list.statusCode, 200)
  assert.deepEqual(
    list.json().entries.map((e: { name: string }) => e.name),
    ["a.ts", "bin.dat"],
  )

  const content = await app.inject({
    method: "GET",
    url: "/api/project-tree/content?root=main&path=src/a.ts",
  })
  assert.equal(content.statusCode, 200)
  assert.equal(content.json().content, "export {}")
  assert.equal(content.json().truncated, false)
  await app.close()
})

test("F028 T14 · error mapping: traversal 400, unknown root 404, missing file 404, denylist 404, binary 400, ADS 400", async () => {
  const app = await makeApp()
  const t400 = await app.inject({ method: "GET", url: "/api/project-tree/list?root=main&dir=../" })
  assert.equal(t400.statusCode, 400)

  const r404 = await app.inject({ method: "GET", url: "/api/project-tree/list?root=wt:nope&dir=" })
  assert.equal(r404.statusCode, 404)

  // 守护 BLOCKED 修复：denied dir 参数本身 → 404（list/content 对称，不枚举主库/.git）
  const denyList = await app.inject({ method: "GET", url: "/api/project-tree/list?root=main&dir=node_modules" })
  assert.equal(denyList.statusCode, 404)
  const denyGit = await app.inject({ method: "GET", url: "/api/project-tree/list?root=main&dir=.git" })
  assert.equal(denyGit.statusCode, 404)

  // 德彪 r1 P1-2：大小写变体（Windows fs 折叠）端到端同样 404
  const denyCase = await app.inject({ method: "GET", url: "/api/project-tree/list?root=main&dir=DATA" })
  assert.equal(denyCase.statusCode, 404)
  const denyCaseContent = await app.inject({
    method: "GET",
    url: "/api/project-tree/content?root=main&path=DATA/prod.sqlite",
  })
  assert.equal(denyCaseContent.statusCode, 404)

  const f404 = await app.inject({
    method: "GET",
    url: "/api/project-tree/content?root=main&path=src/ghost.ts",
  })
  assert.equal(f404.statusCode, 404)

  const deny404 = await app.inject({
    method: "GET",
    url: "/api/project-tree/content?root=main&path=.env",
  })
  assert.equal(deny404.statusCode, 404)

  const bin400 = await app.inject({
    method: "GET",
    url: "/api/project-tree/content?root=main&path=src/bin.dat",
  })
  assert.equal(bin400.statusCode, 400)
  assert.equal(bin400.json().code, "BINARY_FILE")

  const ads400 = await app.inject({
    method: "GET",
    url: `/api/project-tree/content?root=main&path=${encodeURIComponent("src/a.ts:x")}`,
  })
  assert.equal(ads400.statusCode, 400)
  await app.close()
})
