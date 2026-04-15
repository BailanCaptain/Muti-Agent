import fs from "node:fs"
import path from "node:path"

export function backupDatabase(dbPath: string): string {
  const dir = path.dirname(dbPath)
  const ext = path.extname(dbPath)
  const base = path.basename(dbPath, ext)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupName = `${base}.backup-${timestamp}${ext}`
  const backupPath = path.join(dir, backupName)
  fs.copyFileSync(dbPath, backupPath)
  const srcSize = fs.statSync(dbPath).size
  const dstSize = fs.statSync(backupPath).size
  if (srcSize !== dstSize) {
    throw new Error(`Backup size mismatch: source ${srcSize} vs backup ${dstSize}`)
  }
  return backupPath
}

export function ensurePreMigrationBackup(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) {
    return null
  }
  return backupDatabase(dbPath)
}

export function rollbackDatabase(backupPath: string, dbPath: string): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }
  fs.copyFileSync(backupPath, dbPath)
}
