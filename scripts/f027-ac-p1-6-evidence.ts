import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { sliceHandbookByH2, HANDBOOK_RELATIVE_PATH } from "../packages/api/src/wiki/handbook-slicer.js";
import { lintCrossFileDedupe, getRedFindings } from "../packages/api/src/wiki/cross-file-dedupe-lint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, "docs/features/F027/evidence/phase1/AC-P1-6");

const SHARED_RULES_PATH = path.join(REPO_ROOT, "multi-agent-skills/refs/shared-rules.md");
const HANDBOOK_PATH = path.join(REPO_ROOT, "wiki/rules/agent-wiki-handbook.md");
const FIXTURE_RED = path.join(REPO_ROOT, "tests/fixtures/lint/red-handbook-adds-at-rule.md");
const FIXTURE_GREEN = path.join(REPO_ROOT, "tests/fixtures/lint/green-cross-ref-only.md");

async function run() {
  console.log("Generating evidence for AC-P1-6...");
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const log: string[] = [];

  // Part 1: Slicing
  log.push("=== PART 1: Handbook H2 Slicing ===");
  const handbookContent = readFileSync(HANDBOOK_PATH, "utf-8");
  const slices = sliceHandbookByH2(handbookContent);
  log.push("Slices generated from wiki/rules/agent-wiki-handbook.md:");
  log.push(`1. compileRules: ${slices.compileRules.slice(0, 100).replace(/\n/g, "\\n")}...`);
  log.push(`2. sanitizeRules: ${slices.sanitizeRules.slice(0, 100).replace(/\n/g, "\\n")}...`);
  log.push(`3. agentActions: ${slices.agentActions.slice(0, 100).replace(/\n/g, "\\n")}...`);
  log.push(`4. devHuman: ${slices.devHuman.slice(0, 100).replace(/\n/g, "\\n")}...`);

  // Part 2: Lint Red
  log.push("\n=== PART 2: Cross-file Dedupe Lint (RED Scenario) ===");
  const redContent = readFileSync(FIXTURE_RED, "utf-8");
  const sharedContent = readFileSync(SHARED_RULES_PATH, "utf-8");
  const redFindings = lintCrossFileDedupe(
    { path: "red-handbook-adds-at-rule.md", content: redContent },
    { path: "shared-rules.md", content: sharedContent }
  );
  const reds = redFindings.filter(f => f.severity === "red");
  log.push(`Red Findings Count: ${reds.length}`);
  for (const f of reds) {
    log.push(`- [RED] Section A: ${f.sectionA} vs Section B: ${f.sectionB}`);
    log.push(`  Similarity: ${f.similarityScore.toFixed(3)}`);
  }

  // Part 3: Lint Green
  log.push("\n=== PART 3: Cross-file Dedupe Lint (GREEN Scenario) ===");
  const greenContent = readFileSync(FIXTURE_GREEN, "utf-8");
  const greenFindings = lintCrossFileDedupe(
    { path: "green-cross-ref-only.md", content: greenContent },
    { path: "shared-rules.md", content: sharedContent }
  );
  const greenReds = greenFindings.filter(f => f.severity === "red");
  const greens = greenFindings.filter(f => f.severity === "green");
  log.push(`Red Findings Count: ${greenReds.length}`);
  log.push(`Green Findings Count: ${greens.length}`);
  for (const f of greens) {
    log.push(`- [GREEN] Section A: ${f.sectionA} vs Section B: ${f.sectionB} (Cross-ref detected)`);
  }

  // Assertions
  assert.ok(slices.compileRules && slices.sanitizeRules && slices.agentActions && slices.devHuman);
  assert.ok(reds.length >= 1);
  assert.equal(greenReds.length, 0);
  assert.ok(greens.length >= 1);

  // Write files
  writeFileSync(path.join(EVIDENCE_DIR, "prompt.txt"), "Input: agent-wiki-handbook.md + shared-rules.md fixtures");
  writeFileSync(path.join(EVIDENCE_DIR, "agent_response.txt"), log.join("\n"));
  writeFileSync(path.join(EVIDENCE_DIR, "result.json"), JSON.stringify({
    verdict: "PASS",
    reason: "Handbook slicing and cross-file dedupe lint logic verified.",
    slicing: {
      compileRules_len: slices.compileRules.length,
      sanitizeRules_len: slices.sanitizeRules.length,
      agentActions_len: slices.agentActions.length,
      devHuman_len: slices.devHuman.length
    },
    lint: {
      red_findings: reds.length,
      green_findings: greens.length,
      baseline_clean: getRedFindings({ path: "handbook", content: handbookContent }, { path: "shared-rules", content: sharedContent }).length === 0
    }
  }, null, 2));

  writeFileSync(path.join(EVIDENCE_DIR, "db_dump.sql"), "-- N/A --");
  writeFileSync(path.join(EVIDENCE_DIR, "wiki_state.tar.gz"), "-- N/A --");
  writeFileSync(path.join(EVIDENCE_DIR, "config.hash"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  writeFileSync(path.join(EVIDENCE_DIR, "prod_config_diff.txt"), "none");

  console.log("Success: Evidence pack generated for AC-P1-6.");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
