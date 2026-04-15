import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

test("backupDatabase creates a timestamped copy of the database file", async () => {
  const { backupDatabase } = await import("./backup")

  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "backup-test-"))

  try {
    const dbPath = path.join(tempDir, "test.sqlite")
    fs.writeFileSync(dbPath, "fake-database-content-12345")

    const backupPath = backupDatabase(dbPath)

    assert.ok(fs.existsSync(backupPath), "backup file should exist")
    assert.ok(
      path.basename(backupPath).startsWith("test.backup-"),
      `backup filename should start with 'test.backup-', got: ${path.basename(backupPath)}`,
    )
    assert.ok(
      backupPath.endsWith(".sqlite"),
      "backup should keep the .sqlite extension",
    )

    const original = fs.readFileSync(dbPath)
    const backup = fs.readFileSync(backupPath)
    assert.deepEqual(original, backup, "backup content should match original")
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("backupDatabase throws if source file does not exist", async () => {
  const { backupDatabase } = await import("./backup")

  assert.throws(
    () => backupDatabase("/nonexistent/path/db.sqlite"),
    /ENOENT|no such file/i,
  )
})

test("ensurePreMigrationBackup skips when DB does not exist", async () => {
  const { ensurePreMigrationBackup } = await import("./backup")

  const result = ensurePreMigrationBackup("/nonexistent/path/db.sqlite")
  assert.equal(result, null)
})

test("ensurePreMigrationBackup creates backup when DB exists", async () => {
  const { ensurePreMigrationBackup } = await import("./backup")

  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "ensure-backup-test-"))

  try {
    const dbPath = path.join(tempDir, "test.sqlite")
    fs.writeFileSync(dbPath, "existing-database-content")

    const backupPath = ensurePreMigrationBackup(dbPath)
    assert.ok(backupPath, "should return backup path for existing DB")
    assert.ok(fs.existsSync(backupPath), "backup file should exist")
    assert.deepEqual(fs.readFileSync(dbPath), fs.readFileSync(backupPath))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("rollbackDatabase restores from backup", async () => {
  const { backupDatabase, rollbackDatabase } = await import("./backup")

  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "rollback-test-"))

  try {
    const dbPath = path.join(tempDir, "test.sqlite")
    fs.writeFileSync(dbPath, "original-content")

    const backupPath = backupDatabase(dbPath)

    fs.writeFileSync(dbPath, "corrupted-content")
    assert.equal(fs.readFileSync(dbPath, "utf8"), "corrupted-content")

    rollbackDatabase(backupPath, dbPath)
    assert.equal(fs.readFileSync(dbPath, "utf8"), "original-content")
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("rollbackDatabase throws if backup file does not exist", async () => {
  const { rollbackDatabase } = await import("./backup")

  assert.throws(
    () => rollbackDatabase("/nonexistent/backup.sqlite", "/some/db.sqlite"),
    /Backup file not found/,
  )
})
