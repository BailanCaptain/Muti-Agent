import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { createDrizzleDb } from "../drizzle-instance"
import { AppStateRepository } from "./app-state-repository"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "f042-appstate-"))
  return createDrizzleDb(path.join(dir, "t.sqlite"))
}

test("app_state: get 缺省 null，set 后可读，重复 set 覆盖（upsert）", () => {
  const { db, close } = makeDb()
  try {
    const repo = new AppStateRepository({ db })
    assert.equal(repo.get("f042_shadow_summary_sent"), null)
    repo.set("f042_shadow_summary_sent", "2026-07-11T00:00:00Z")
    assert.equal(repo.get("f042_shadow_summary_sent"), "2026-07-11T00:00:00Z")
    repo.set("f042_shadow_summary_sent", "v2")
    assert.equal(repo.get("f042_shadow_summary_sent"), "v2")
  } finally {
    close()
  }
})

test("F042 AC2 · prompt_audit 采纳三列存在（INIT_SQL 新库 + MIGRATIONS 老库同源生效）", () => {
  const { db, raw, close } = makeDb()
  try {
    void db
    const rows = raw.prepare("PRAGMA table_info(prompt_audit)").all() as Array<{ name: string }>
    const cols = rows.map((r) => r.name)
    for (const c of ["recall_mode", "recall_adopted", "recall_adoption_detail"]) {
      assert.ok(cols.includes(c), `prompt_audit 缺列 ${c}`)
    }
  } finally {
    close()
  }
})
