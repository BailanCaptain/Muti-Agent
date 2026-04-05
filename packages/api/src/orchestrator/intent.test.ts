import assert from "node:assert/strict"
import test from "node:test"
import { parseIntent } from "./intent"

test("parseIntent returns execute for 0 mentions", () => {
  assert.equal(parseIntent(0), "execute")
})

test("parseIntent returns execute for 1 mention", () => {
  assert.equal(parseIntent(1), "execute")
})

test("parseIntent returns ideate for 2 mentions", () => {
  assert.equal(parseIntent(2), "ideate")
})

test("parseIntent returns ideate for 3 mentions", () => {
  assert.equal(parseIntent(3), "ideate")
})

test("parseIntent returns ideate for many mentions", () => {
  assert.equal(parseIntent(10), "ideate")
})
