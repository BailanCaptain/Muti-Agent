import test from "node:test"
import assert from "node:assert/strict"
import { DecisionBoard } from "./decision-board"

const baseRaiser = {
  threadId: "t-claude",
  provider: "claude" as const,
  alias: "黄仁勋",
  raisedAt: "2026-04-10T10:00:00Z",
}

test("DecisionBoard.add stores a new entry", () => {
  const board = new DecisionBoard()
  const result = board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库用 PG 还是 SQLite？",
    options: [
      { id: "A", label: "PG" },
      { id: "B", label: "SQLite" },
    ],
  })
  assert.equal(result.kind, "added")
  assert.equal(result.entry.question, "数据库用 PG 还是 SQLite？")
  assert.equal(result.entry.raisers.length, 1)
  const pending = board.getPending("g1")
  assert.equal(pending.length, 1)
})

test("DecisionBoard.add merges same-hash questions across raisers", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型要用 PostgreSQL 还是 SQLite",
    options: [{ id: "A", label: "PG" }],
  })
  const second = board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t-codex", provider: "codex", alias: "范德彪" },
    question: "数据库选型要用 PostgreSQL 还是 SQLite",
    options: [{ id: "A", label: "PG" }],
  })
  assert.equal(second.kind, "merged")
  assert.equal(second.entry.raisers.length, 2)
  assert.equal(board.getPending("g1").length, 1)
})

test("DecisionBoard.add dedupes paraphrased question via normalization", () => {
  const board = new DecisionBoard()
  const first = board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库是否要用PG？",
    options: [],
  })
  const second = board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t2" },
    question: "数据库要用PG吗",
    options: [],
  })
  assert.equal(second.kind, "merged")
  assert.equal(first.entry.questionHash, second.entry.questionHash)
})

test("DecisionBoard.withdraw removes matching entry for same raiser", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型要不要换 PG",
    options: [],
  })
  const withdrawn = board.withdraw("g1", "t-claude", "数据库")
  assert.notEqual(withdrawn, null)
  assert.equal(board.getPending("g1").length, 0)
})

test("DecisionBoard.withdraw refuses cross-raiser withdrawal", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型",
    options: [],
  })
  const withdrawn = board.withdraw("g1", "t-other-agent", "数据库")
  assert.equal(withdrawn, null)
  assert.equal(board.getPending("g1").length, 1)
})

test("DecisionBoard.withdraw keeps entry when another raiser still owns it", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型",
    options: [],
  })
  board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t-codex", provider: "codex", alias: "范德彪" },
    question: "数据库选型",
    options: [],
  })
  board.withdraw("g1", "t-claude", "数据库")
  const pending = board.getPending("g1")
  assert.equal(pending.length, 1)
  assert.equal(pending[0].raisers.length, 1)
  assert.equal(pending[0].raisers[0].threadId, "t-codex")
})

test("DecisionBoard.drain returns and clears all entries for a session", () => {
  const board = new DecisionBoard()
  board.add({ sessionGroupId: "g1", raiser: baseRaiser, question: "Q1", options: [] })
  board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t2" },
    question: "Q2",
    options: [],
  })
  const drained = board.drain("g1")
  assert.equal(drained.length, 2)
  assert.equal(board.getPending("g1").length, 0)
})

test("DecisionBoard.drain is scoped to one session", () => {
  const board = new DecisionBoard()
  board.add({ sessionGroupId: "g1", raiser: baseRaiser, question: "Q1", options: [] })
  board.add({ sessionGroupId: "g2", raiser: baseRaiser, question: "Q2", options: [] })
  board.drain("g1")
  assert.equal(board.getPending("g2").length, 1)
})
