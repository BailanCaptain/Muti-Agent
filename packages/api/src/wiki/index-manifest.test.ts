/**
 * F027 P21 · Atomic Manifest Protocol 单测
 * 真相源：docs/plans/V16.5-final.md chap 19
 *
 * 覆盖：
 *   - write happy path → readManifest 一致
 *   - overwrite 原子（写新版后老版 hash 全替换）
 *   - 模拟崩溃残留 tmp → cleanupOrphanTmp 删除 + readManifest 仍读旧 manifest
 *   - readManifest 缺文件返 null
 *   - readManifest 损坏 JSON 抛
 *   - readManifest schema invalid 抛（缺字段）
 *   - cleanupOrphanTmp 没残留返 false 不抛
 *   - 多次 write 后 readManifest 总是最新版
 *   - mkdir -p 自动建父目录
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  type IndexManifest,
  MANIFEST_FILENAME,
  TMP_SUFFIX,
  cleanupOrphanTmp,
  manifestPath,
  readManifest,
  tmpManifestPath,
  writeManifestAtomic,
} from "./index-manifest"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

function sampleManifest(over: Partial<IndexManifest> = {}): IndexManifest {
  return {
    version: over.version ?? "2026050601",
    generatedAt: over.generatedAt ?? "2026-05-06T04:00:00Z",
    files: over.files ?? [
      { path: "rules.md", hash: "sha256:aaa", sizeBytes: 1234 },
      { path: "concepts.md", hash: "sha256:bbb", sizeBytes: 5678 },
    ],
    sourceEventSeq: over.sourceEventSeq ?? 42,
  }
}

test("F027 P21: write happy path → readManifest 一致", () => {
  const dir = safeTempDir("p21-write-")
  try {
    const m = sampleManifest()
    writeManifestAtomic(dir, m)
    const back = readManifest(dir)
    assert.deepEqual(back, m)
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: write 后 manifest.json 落盘且 .tmp 已 rename 消失", () => {
  const dir = safeTempDir("p21-tmp-cleanup-")
  try {
    writeManifestAtomic(dir, sampleManifest())
    assert.ok(fs.existsSync(manifestPath(dir)), "manifest.json should exist")
    assert.ok(!fs.existsSync(tmpManifestPath(dir)), "tmp should be consumed by rename")
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: overwrite 原子 — 写新版 readManifest 全切换不留旧版字段", () => {
  const dir = safeTempDir("p21-overwrite-")
  try {
    writeManifestAtomic(
      dir,
      sampleManifest({
        version: "v1",
        files: [{ path: "old.md", hash: "sha256:old", sizeBytes: 100 }],
        sourceEventSeq: 10,
      }),
    )
    writeManifestAtomic(
      dir,
      sampleManifest({
        version: "v2",
        files: [{ path: "new.md", hash: "sha256:new", sizeBytes: 200 }],
        sourceEventSeq: 20,
      }),
    )
    const back = readManifest(dir)
    assert.equal(back?.version, "v2")
    assert.equal(back?.sourceEventSeq, 20)
    assert.equal(back?.files.length, 1)
    assert.equal(back?.files[0].path, "new.md")
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: 崩溃模拟 — 手工写残留 .tmp 但不 rename → readManifest 仍读老 manifest", () => {
  const dir = safeTempDir("p21-crash-")
  try {
    // 第一份正常落盘
    writeManifestAtomic(dir, sampleManifest({ version: "stable" }))
    // 模拟下次 write 崩溃：手工 dump 一份 .tmp 文件占位
    fs.writeFileSync(tmpManifestPath(dir), '{"crash": "halfway"}')

    // 读应当仍然是 stable manifest（rename 没发生）
    const back = readManifest(dir)
    assert.equal(back?.version, "stable")
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: cleanupOrphanTmp 删 .tmp + 不动 manifest.json，返回 true", () => {
  const dir = safeTempDir("p21-cleanup-")
  try {
    writeManifestAtomic(dir, sampleManifest({ version: "stable" }))
    fs.writeFileSync(tmpManifestPath(dir), "garbage")
    assert.ok(fs.existsSync(tmpManifestPath(dir)))

    const cleaned = cleanupOrphanTmp(dir)
    assert.equal(cleaned, true)
    assert.ok(!fs.existsSync(tmpManifestPath(dir)))
    // manifest.json 不动
    const back = readManifest(dir)
    assert.equal(back?.version, "stable")
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: cleanupOrphanTmp 没残留返 false 不抛（idempotent）", () => {
  const dir = safeTempDir("p21-cleanup-noop-")
  try {
    writeManifestAtomic(dir, sampleManifest())
    assert.equal(cleanupOrphanTmp(dir), false)
    // 再叫一次也无副作用
    assert.equal(cleanupOrphanTmp(dir), false)
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: readManifest 缺文件返 null（首次启动场景）", () => {
  const dir = safeTempDir("p21-empty-")
  try {
    assert.equal(readManifest(dir), null)
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: readManifest 损坏 JSON 抛", () => {
  const dir = safeTempDir("p21-malformed-")
  try {
    fs.writeFileSync(manifestPath(dir), "{not valid json")
    assert.throws(() => readManifest(dir))
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: readManifest schema invalid 抛（缺必填字段）", () => {
  const dir = safeTempDir("p21-schema-")
  try {
    fs.writeFileSync(
      manifestPath(dir),
      JSON.stringify({ version: "x", generatedAt: "y" /* 缺 files / sourceEventSeq */ }),
    )
    assert.throws(() => readManifest(dir), /Invalid manifest schema/)

    // files 数组里 entry 缺字段也抛
    fs.writeFileSync(
      manifestPath(dir),
      JSON.stringify({
        version: "x",
        generatedAt: "y",
        sourceEventSeq: 0,
        files: [{ path: "x.md" /* 缺 hash / sizeBytes */ }],
      }),
    )
    assert.throws(() => readManifest(dir), /Invalid manifest schema/)
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: writeManifestAtomic mkdir -p 自动建父目录（首次写 wiki/index/）", () => {
  const root = safeTempDir("p21-mkdir-")
  const nested = path.join(root, "wiki", "index")
  try {
    assert.ok(!fs.existsSync(nested), "nested dir should not pre-exist")
    writeManifestAtomic(nested, sampleManifest())
    assert.ok(fs.existsSync(manifestPath(nested)))
  } finally {
    safeCleanup(root)
  }
})

test("F027 P21: 多次 write 后 readManifest 总是最新版（顺序一致性）", () => {
  const dir = safeTempDir("p21-sequential-")
  try {
    for (let i = 1; i <= 5; i++) {
      writeManifestAtomic(
        dir,
        sampleManifest({ version: `v-${i}`, sourceEventSeq: i * 10 }),
      )
      const back = readManifest(dir)
      assert.equal(back?.version, `v-${i}`)
      assert.equal(back?.sourceEventSeq, i * 10)
    }
  } finally {
    safeCleanup(dir)
  }
})

test("F027 P21: 文件名 / 后缀常量与契约一致（防误改）", () => {
  assert.equal(MANIFEST_FILENAME, "manifest.json")
  assert.equal(TMP_SUFFIX, ".tmp")
})
