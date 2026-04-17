import assert from "node:assert/strict"
import test from "node:test"

test("schema exports all 11 tables (F018 messageEmbeddings + F019 workflowSop)", async () => {
  const schema = await import("./schema")

  const expectedTables = [
    "sessionGroups",
    "threads",
    "messages",
    "invocations",
    "agentEvents",
    "sessionMemories",
    "tasks",
    "authorizationRules",
    "authorizationAudit",
    "messageEmbeddings", // F018 AC6.1 / AC8.2 — F007 AC5.2 回填
    "workflowSop", // F019 P2 — 告示牌状态机
  ]

  for (const name of expectedTables) {
    assert.ok(
      (schema as Record<string, unknown>)[name],
      `schema should export '${name}'`,
    )
  }
})

test("F018 AC8.1: threads table has nullable thread_memory column", async () => {
  const schema = await import("./schema")
  const { getTableColumns } = await import("drizzle-orm")
  const threadCols = getTableColumns(schema.threads)
  assert.ok(threadCols.threadMemory, "threads should have threadMemory column (F018)")
})

test("F018 AC8.2 / AC6.1: message_embeddings table has required columns", async () => {
  const schema = await import("./schema")
  const { getTableColumns } = await import("drizzle-orm")
  assert.ok(schema.messageEmbeddings, "messageEmbeddings table should be exported")
  const cols = getTableColumns(schema.messageEmbeddings)
  assert.ok(cols.id, "messageEmbeddings should have id")
  assert.ok(cols.messageId, "messageEmbeddings should have messageId")
  assert.ok(cols.threadId, "messageEmbeddings should have threadId")
  assert.ok(cols.chunkIndex, "messageEmbeddings should have chunkIndex")
  assert.ok(cols.chunkText, "messageEmbeddings should have chunkText")
  assert.ok(cols.embedding, "messageEmbeddings should have embedding (BLOB)")
  assert.ok(cols.createdAt, "messageEmbeddings should have createdAt")
})

test("schema tables have correct column structures", async () => {
  const schema = await import("./schema")
  const { getTableColumns } = await import("drizzle-orm")

  const sessionGroupCols = getTableColumns(schema.sessionGroups)
  assert.ok(sessionGroupCols.id, "sessionGroups should have id")
  assert.ok(sessionGroupCols.title, "sessionGroups should have title")
  assert.ok(sessionGroupCols.projectTag, "sessionGroups should have projectTag")
  assert.ok(sessionGroupCols.createdAt, "sessionGroups should have createdAt")
  assert.ok(sessionGroupCols.updatedAt, "sessionGroups should have updatedAt")

  const threadCols = getTableColumns(schema.threads)
  assert.ok(threadCols.id, "threads should have id")
  assert.ok(threadCols.sessionGroupId, "threads should have sessionGroupId")
  assert.ok(threadCols.provider, "threads should have provider")
  assert.ok(threadCols.sopBookmark, "threads should have sopBookmark")
  assert.ok(threadCols.lastFillRatio, "threads should have lastFillRatio")

  const msgCols = getTableColumns(schema.messages)
  assert.ok(msgCols.id, "messages should have id")
  assert.ok(msgCols.threadId, "messages should have threadId")
  assert.ok(msgCols.role, "messages should have role")
  assert.ok(msgCols.content, "messages should have content")
  assert.ok(msgCols.thinking, "messages should have thinking")
  assert.ok(msgCols.messageType, "messages should have messageType")
  assert.ok(msgCols.connectorSource, "messages should have connectorSource")
  assert.ok(msgCols.groupId, "messages should have groupId")
  assert.ok(msgCols.groupRole, "messages should have groupRole")
  assert.ok(msgCols.toolEvents, "messages should have toolEvents")
  assert.ok(msgCols.contentBlocks, "messages should have contentBlocks")

  const invCols = getTableColumns(schema.invocations)
  assert.ok(invCols.exitCode, "invocations should have exitCode")
  assert.ok(invCols.lastActivityAt, "invocations should have lastActivityAt")

  const auditCols = getTableColumns(schema.authorizationAudit)
  assert.ok(auditCols.requestId, "authorizationAudit should have requestId")
  assert.ok(auditCols.matchedRuleId, "authorizationAudit should have matchedRuleId")
})

test("threads has backlogItemId column (F019 feature→thread binding)", async () => {
  const schema = await import("./schema")
  const { getTableColumns } = await import("drizzle-orm")
  const threadCols = getTableColumns(schema.threads)
  assert.ok(threadCols.backlogItemId, "threads should have backlogItemId column")
})

test("workflow_sop table has F019 state machine columns", async () => {
  const schema = await import("./schema")
  const { getTableColumns } = await import("drizzle-orm")
  const cols = getTableColumns(schema.workflowSop)
  assert.ok(cols.backlogItemId, "workflowSop should have backlogItemId (PK)")
  assert.ok(cols.featureId, "workflowSop should have featureId")
  assert.ok(cols.stage, "workflowSop should have stage")
  assert.ok(cols.batonHolder, "workflowSop should have batonHolder")
  assert.ok(cols.nextSkill, "workflowSop should have nextSkill")
  assert.ok(cols.resumeCapsule, "workflowSop should have resumeCapsule (JSON)")
  assert.ok(cols.checks, "workflowSop should have checks (JSON)")
  assert.ok(cols.version, "workflowSop should have version (optimistic lock)")
  assert.ok(cols.updatedAt, "workflowSop should have updatedAt")
  assert.ok(cols.updatedBy, "workflowSop should have updatedBy")
})
