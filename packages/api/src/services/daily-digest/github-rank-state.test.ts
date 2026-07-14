import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  applyGithubRankStatuses,
  loadGithubRankHistory,
  resolveGithubRankStatus,
  type GithubRankSnapshot,
  writeGithubRankSnapshot,
} from "./github-rank-state"
import { buildNormalizedItem } from "./feed-parsers"
import type { NormalizedItem } from "./types"

const DAILY = "github-trending-daily"
const NEWCOMER = "github-ai-newcomers"
const WEEKLY = "github-trending-weekly"
const MONTHLY = "github-trending-monthly"
const REPO = "https://github.com/Panniantong/Agent-Reach"

function githubItem(sourceId = DAILY, repo = "Panniantong/Agent-Reach"): NormalizedItem {
  const item = buildNormalizedItem(
    sourceId,
    "github",
    repo,
    `https://github.com/${repo}`,
    null,
    "+100 stars today · ★1,000 · TypeScript · AI agent search",
  )
  return {
    ...item,
    githubMeta: {
      repo,
      period:
        sourceId === NEWCOMER
          ? "newcomer"
          : sourceId === WEEKLY
            ? "weekly"
            : sourceId === MONTHLY
              ? "monthly"
              : "daily",
      windowStars: 100,
      totalStars: 1_000,
      language: "TypeScript",
      description: "AI agent search",
      evidence: {
        topics: [],
        metadataStatus: "not_requested",
        readmeStatus: "not_requested",
        evidenceComplete: false,
      },
      eligibility: { state: "yes", confidence: 0.98, reasons: ["AI 是核心用途"] },
    },
  }
}

function snapshot(businessDate: string, lists: GithubRankSnapshot["lists"]): GithubRankSnapshot {
  return { businessDate, lists }
}

describe("GitHub 增长榜/新秀榜跨日状态（只标注，不抑制）", () => {
  it("首次进入增长榜 → NEW", () => {
    assert.deepEqual(
      resolveGithubRankStatus({
        sourceId: DAILY,
        repoKey: REPO,
        businessDate: "2026-07-10",
        history: [],
      }),
      { kind: "new" },
    )
  })

  it("增长榜连续出现仍保留，并得到连续 X 日上榜", () => {
    assert.deepEqual(
      resolveGithubRankStatus({
        sourceId: DAILY,
        repoKey: REPO,
        businessDate: "2026-07-12",
        history: [
          snapshot("2026-07-10", { [DAILY]: [REPO] }),
          snapshot("2026-07-11", { [DAILY]: [REPO] }),
        ],
      }),
      { kind: "streak", days: 3 },
    )
  })

  it("中断一天后重新进入增长榜 → 重新上榜", () => {
    assert.deepEqual(
      resolveGithubRankStatus({
        sourceId: DAILY,
        repoKey: REPO,
        businessDate: "2026-07-12",
        history: [
          snapshot("2026-07-10", { [DAILY]: [REPO] }),
          snapshot("2026-07-11", { [DAILY]: [] }),
        ],
      }),
      { kind: "returning" },
    )
  })

  it("新秀榜使用同一套 NEW / 连续 / 重新上榜状态机", () => {
    const day1 = resolveGithubRankStatus({
      sourceId: NEWCOMER,
      repoKey: REPO,
      businessDate: "2026-07-10",
      history: [],
    })
    const day2 = resolveGithubRankStatus({
      sourceId: NEWCOMER,
      repoKey: REPO,
      businessDate: "2026-07-11",
      history: [snapshot("2026-07-10", { [NEWCOMER]: [REPO] })],
    })
    const returning = resolveGithubRankStatus({
      sourceId: NEWCOMER,
      repoKey: REPO,
      businessDate: "2026-07-13",
      history: [
        snapshot("2026-07-10", { [NEWCOMER]: [REPO] }),
        snapshot("2026-07-11", { [NEWCOMER]: [] }),
        snapshot("2026-07-12", { [NEWCOMER]: [] }),
      ],
    })

    assert.deepEqual(day1, { kind: "new" })
    assert.deepEqual(day2, { kind: "streak", days: 2 })
    assert.deepEqual(returning, { kind: "returning" })
  })

  it("周榜/月榜不读取跨日状态：重复出现也不附加状态、更不能被去重", () => {
    const history = [
      snapshot("2026-07-10", { [WEEKLY]: [REPO], [MONTHLY]: [REPO] }),
      snapshot("2026-07-11", { [WEEKLY]: [REPO], [MONTHLY]: [REPO] }),
    ]

    assert.equal(
      resolveGithubRankStatus({
        sourceId: WEEKLY,
        repoKey: REPO,
        businessDate: "2026-07-12",
        history,
      }),
      null,
    )
    assert.equal(
      resolveGithubRankStatus({
        sourceId: MONTHLY,
        repoKey: REPO,
        businessDate: "2026-07-12",
        history,
      }),
      null,
    )
  })

  it("接入条目时只加状态、不隐藏仍在榜项目；周榜/月榜保持无状态", () => {
    const daily = githubItem(DAILY)
    const weekly = githubItem(WEEKLY, "owner/weekly-ai")
    const annotated = applyGithubRankStatuses([daily, weekly], "2026-07-11", [
      snapshot("2026-07-10", { [DAILY]: [REPO], [WEEKLY]: [weekly.canonicalUrl] }),
    ])

    assert.equal(annotated.length, 2)
    assert.deepEqual(annotated[0].githubMeta?.rankStatus, { kind: "streak", days: 2 })
    assert.equal(annotated[1].githubMeta?.rankStatus, undefined)
  })

  it("发送成功快照按日期持久化；同日补发取并集且不制造额外连续天数", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-github-rank-"))
    const day1 = githubItem(DAILY)
    writeGithubRankSnapshot(baseDir, "2026-07-10", [day1])
    writeGithubRankSnapshot(baseDir, "2026-07-10", [githubItem(DAILY, "owner/second-ai-repo")])

    const history = loadGithubRankHistory(baseDir, "2026-07-11")
    assert.equal(history.length, 1)
    assert.deepEqual(history[0].lists[DAILY], [REPO, "https://github.com/owner/second-ai-repo"])
    assert.deepEqual(
      applyGithubRankStatuses([day1], "2026-07-11", history)[0].githubMeta?.rankStatus,
      { kind: "streak", days: 2 },
    )
  })
})
