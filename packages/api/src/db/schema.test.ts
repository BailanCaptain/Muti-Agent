import assert from "node:assert/strict"
import test from "node:test"

test("schema exports all 9 tables", async () => {
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
  ]

  for (const name of expectedTables) {
    assert.ok(
      (schema as Record<string, unknown>)[name],
      `schema should export '${name}'`,
    )
  }
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
