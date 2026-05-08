#!/usr/bin/env bash
# F026 ADR-004 diff guard — agent prompt 层对 A2A 透明
#
# 强约束（docs/adrs/ADR-004）：
#   CLAUDE.md / GEMINI.md / AGENTS.md / packages/api/src/runtime/agent-prompts.ts
#   这四个文件**禁止承载任何 A2A 协议内容**（call_id / envelope / on_behalf_of / ...）。
#   Phase 1 完结前 diff（相对 base 分支）的 net insertion 必须 ≤ 0。
#
# 用法：
#   ./scripts/ci/check-adr-004-diff.sh           # 自动选 base: dev → origin/dev → origin/main → main
#   BASE=<ref> ./scripts/ci/check-adr-004-diff.sh   # 显式指定 base（CI 推荐：origin/dev）

set -euo pipefail

YELLOW='\033[0;33m'
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

FILES=(
  "CLAUDE.md"
  "GEMINI.md"
  "AGENTS.md"
  "packages/api/src/runtime/agent-prompts.ts"
)

# Resolve base ref — use merge-base (branch fork point), not the moving tip of main.
# Rationale: those prompt files may have been edited by other features after
# F026 Phase 1 branched off; we only police diffs *within* Phase 1's work.
#
# Priority: BASE env > local dev > origin/dev > origin/main > main.
# Multi-Agent 内部 PR 的实际分叉来自 dev，不是 main — main 可能只到 Initial commit。
# GitHub Actions checkout 不会创建本地 dev，只有 remote refs，所以必须先探 origin/dev
# 再落 origin/main，否则在 Actions 里会把"F026 相对 main 的全部改动"都算成违规。
if [ -n "${BASE:-}" ]; then
  if BASE_MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null)"; then
    BASE_REF="$BASE_MERGE_BASE"
  else
    BASE_REF="$BASE"
  fi
elif git rev-parse --verify dev >/dev/null 2>&1; then
  BASE_REF="$(git merge-base dev HEAD)"
elif git rev-parse --verify origin/dev >/dev/null 2>&1; then
  BASE_REF="$(git merge-base origin/dev HEAD)"
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
  BASE_REF="$(git merge-base origin/main HEAD)"
elif git rev-parse --verify main >/dev/null 2>&1; then
  BASE_REF="$(git merge-base main HEAD)"
else
  echo -e "${RED}ERROR${NC}: could not resolve base ref (need dev, origin/dev, origin/main, main, or BASE env)"
  exit 2
fi

echo "ADR-004 diff guard · base = ${BASE_REF}"

violations=0

for file in "${FILES[@]}"; do
  if [ ! -f "$file" ]; then
    # File missing locally is fine (GEMINI.md / AGENTS.md may not exist yet)
    continue
  fi

  stats=$(git diff --numstat "$BASE_REF" -- "$file" 2>/dev/null || true)
  if [ -z "$stats" ]; then
    echo -e "  ${GREEN}✓${NC} ${file} (no diff vs ${BASE_REF})"
    continue
  fi

  ins=$(echo "$stats" | awk '{print $1}')
  del=$(echo "$stats" | awk '{print $2}')
  # Guard against non-numeric output (binary files etc.)
  if ! [[ "$ins" =~ ^[0-9]+$ ]] || ! [[ "$del" =~ ^[0-9]+$ ]]; then
    echo -e "  ${YELLOW}?${NC} ${file} non-numeric stats: '${stats}'"
    continue
  fi

  net=$((ins - del))
  if [ "$net" -gt 0 ]; then
    echo -e "  ${RED}✗${NC} ${file} net +${net} lines (${ins} insertions, ${del} deletions) since ${BASE_REF}"
    echo -e "    ${YELLOW}ADR-004 VIOLATION${NC}: A2A 协议内容禁止进入 agent prompt 层。见 docs/adrs/ADR-004-a2a-transparent-to-agent.md"
    violations=$((violations + 1))
  else
    echo -e "  ${GREEN}✓${NC} ${file} net ${net} lines (${ins} ins, ${del} del)"
  fi
done

if [ "$violations" -gt 0 ]; then
  echo -e "${RED}ADR-004 diff guard: ${violations} violation(s)${NC}"
  exit 1
fi

echo -e "${GREEN}ADR-004 diff guard: clean${NC}"

# ---------------------------------------------------------------
# F026 Phase 2 Task F · content-layer guard
#
# Diff-size is blind to net-zero swaps (delete one line, add one
# line carrying forbidden tokens). Scan the same four files for
# A2A protocol tokens that must NEVER appear in the agent-prompt
# layer. Mirror of scripts/ci/check-adr-004-content.ts (unit
# tests) for CI shells where pnpm test is not invoked.
# ---------------------------------------------------------------

FORBIDDEN_PATTERNS='Direct message from|a2aFrom|triggerMessage'
content_violations=0

for file in "${FILES[@]}"; do
  [ -f "$file" ] || continue
  if grep -iE "$FORBIDDEN_PATTERNS" "$file" >/dev/null 2>&1; then
    echo -e "  ${RED}✗${NC} ${file} contains A2A protocol leakage (matches: ${FORBIDDEN_PATTERNS})"
    echo -e "    ${YELLOW}ADR-004 VIOLATION${NC}: agent prompt 层禁止承载 A2A 协议内容。"
    content_violations=$((content_violations + 1))
  fi
done

if [ "$content_violations" -gt 0 ]; then
  echo -e "${RED}ADR-004 content guard: ${content_violations} violation(s)${NC}"
  exit 1
fi

echo -e "${GREEN}ADR-004 content guard: clean${NC}"
