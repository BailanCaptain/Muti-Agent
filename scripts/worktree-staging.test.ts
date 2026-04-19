import assert from "node:assert/strict"
import test from "node:test"

import {
  buildCreateWorktreeArgs,
  buildDestroyWorktreeArgs,
  buildMergeArgs,
  buildStagingBranchName,
  parseStagingManifest,
} from "./worktree-staging"

test("F024 parseStagingManifest accepts a well-formed manifest", () => {
  const m = parseStagingManifest({
    stagingId: "f021-f022-check",
    baseRef: "dev",
    visionVersion: "2026-04-19",
    features: [
      { featureId: "F021", commitSha: "aaaaaaaa" },
      { featureId: "F022", commitSha: "bbbbbbbb" },
    ],
  })
  assert.equal(m.stagingId, "f021-f022-check")
  assert.equal(m.baseRef, "dev")
  assert.equal(m.visionVersion, "2026-04-19")
  assert.deepEqual(m.features, [
    { featureId: "F021", commitSha: "aaaaaaaa" },
    { featureId: "F022", commitSha: "bbbbbbbb" },
  ])
})

test("F024 parseStagingManifest rejects manifest without visionVersion", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo",
        baseRef: "dev",
        features: [{ featureId: "F021", commitSha: "abc" }],
      }),
    /visionVersion/,
  )
})

test("F024 parseStagingManifest rejects manifest without stagingId", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        baseRef: "dev",
        visionVersion: "2026-04-19",
        features: [{ featureId: "F021", commitSha: "abc" }],
      }),
    /stagingId/,
  )
})

test("F024 parseStagingManifest rejects manifest without baseRef", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo",
        visionVersion: "2026-04-19",
        features: [{ featureId: "F021", commitSha: "abc" }],
      }),
    /baseRef/,
  )
})

test("F024 parseStagingManifest rejects manifest with empty features", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo",
        baseRef: "dev",
        visionVersion: "2026-04-19",
        features: [],
      }),
    /features/,
  )
})

test("F024 parseStagingManifest rejects feature missing commitSha", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo",
        baseRef: "dev",
        visionVersion: "2026-04-19",
        features: [{ featureId: "F021" }],
      }),
    /commitSha/,
  )
})

test("F024 parseStagingManifest rejects feature missing featureId", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo",
        baseRef: "dev",
        visionVersion: "2026-04-19",
        features: [{ commitSha: "abc" }],
      }),
    /featureId/,
  )
})

test("F024 buildStagingBranchName enforces staging prefix", () => {
  assert.equal(buildStagingBranchName("f021-f022"), "staging/f021-f022")
})

test("F024 buildStagingBranchName rejects stagingId that already starts with staging/", () => {
  assert.throws(() => buildStagingBranchName("staging/f021"), /already/)
})

test("F024 buildStagingBranchName rejects empty stagingId", () => {
  assert.throws(() => buildStagingBranchName(""), /stagingId/)
})

test("F024 buildCreateWorktreeArgs passes manifest fields as argv tokens so shell metacharacters can't inject (review P1-B)", () => {
  const { args } = buildCreateWorktreeArgs({
    worktreeDir: "/tmp/multi-agent-staging-x",
    branch: "staging/inj&echo HACKED",
    baseRef: "dev;rm -rf /",
  })

  assert.deepEqual(args, [
    "worktree",
    "add",
    "/tmp/multi-agent-staging-x",
    "-b",
    "staging/inj&echo HACKED",
    "dev;rm -rf /",
  ])
})

test("F024 buildMergeArgs passes commitSha as literal argv token (review P1-B)", () => {
  const { args } = buildMergeArgs({ commitSha: "abcd1234|whoami" })
  assert.deepEqual(args, ["merge", "--no-ff", "--no-edit", "abcd1234|whoami"])
})

test("F024 buildDestroyWorktreeArgs returns remove + branch-delete arg tuples without shell interpolation (review P1-B)", () => {
  const { removeArgs, branchDeleteArgs } = buildDestroyWorktreeArgs({
    worktreeDir: "/tmp/multi-agent-staging-x",
    branch: "staging/inj&echo HACKED",
  })

  assert.deepEqual(removeArgs, ["worktree", "remove", "--force", "/tmp/multi-agent-staging-x"])
  assert.deepEqual(branchDeleteArgs, ["branch", "-D", "staging/inj&echo HACKED"])
})

test("F024 parseStagingManifest rejects stagingId containing shell metacharacters as defence in depth (review P1-B)", () => {
  assert.throws(
    () =>
      parseStagingManifest({
        stagingId: "demo&echo HACKED",
        baseRef: "dev",
        visionVersion: "2026-04-19",
        features: [{ featureId: "F021", commitSha: "abc" }],
      }),
    /stagingId/,
  )
})
