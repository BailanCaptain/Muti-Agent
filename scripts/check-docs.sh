#!/usr/bin/env bash
set -euo pipefail

ERRORS=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

error() {
  echo -e "${RED}ERROR${NC}: $1"
  ERRORS=$((ERRORS + 1))
}

# --- Check 1: No **Status**: xxx in body text (double-write detection) ---
for f in docs/features/*.md docs/bugReport/*.md; do
  [ -f "$f" ] || continue
  in_frontmatter=0
  line_num=0
  frontmatter_end=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    if [ "$line_num" -eq 1 ] && [ "$line" = "---" ]; then
      in_frontmatter=1
      continue
    fi
    if [ "$in_frontmatter" -eq 1 ] && [ "$line" = "---" ]; then
      in_frontmatter=0
      frontmatter_end=$line_num
      continue
    fi
    if [ "$in_frontmatter" -eq 0 ] && [ "$frontmatter_end" -gt 0 ]; then
      if echo "$line" | grep -qP '^\*\*Status\*\*\s*:'; then
        error "$f:$line_num — body contains '**Status**: ...' (should only be in frontmatter)"
      fi
    fi
  done < "$f"
done

# --- Check 2: Feature frontmatter status whitelist ---
VALID_STATUSES="spec in-progress done"
for f in docs/features/*.md; do
  [ -f "$f" ] || continue
  status=$(grep -m1 '^status:' "$f" | sed 's/^status:\s*//' | tr -d '[:space:]')
  if [ -z "$status" ]; then
    continue
  fi
  valid=0
  for s in $VALID_STATUSES; do
    if [ "$status" = "$s" ]; then
      valid=1
      break
    fi
  done
  if [ "$valid" -eq 0 ]; then
    error "$f — status '$status' not in whitelist ($VALID_STATUSES)"
  fi
done

# --- Check 3: status: done must have completed: field ---
for f in docs/features/*.md; do
  [ -f "$f" ] || continue
  status=$(grep -m1 '^status:' "$f" | sed 's/^status:\s*//' | tr -d '[:space:]')
  if [ "$status" = "done" ]; then
    if ! grep -q '^completed:' "$f"; then
      error "$f — status is 'done' but missing 'completed:' date in frontmatter"
    fi
  fi
done

# --- Check 4: ROADMAP ↔ frontmatter status cross-validation ---
ROADMAP="docs/ROADMAP.md"
if [ -f "$ROADMAP" ]; then
  in_active=0
  in_completed=0
  while IFS= read -r line; do
    if echo "$line" | grep -q '## 活跃 Features'; then
      in_active=1; in_completed=0; continue
    fi
    if echo "$line" | grep -q '## 已完成 Features'; then
      in_active=0; in_completed=1; continue
    fi

    # Active table rows: | Fxxx | name | status | ...
    if [ "$in_active" -eq 1 ]; then
      fid=$(echo "$line" | grep -oP '^\|\s*F\d+' | tr -d '| ' || true)
      if [ -n "$fid" ]; then
        roadmap_status=$(echo "$line" | awk -F'|' '{print $4}' | tr -d '[:space:]')
        spec_file=$(find docs/features -name "${fid}-*" -o -name "${fid,,}-*" 2>/dev/null | head -1)
        if [ -n "$spec_file" ] && [ -f "$spec_file" ]; then
          file_status=$(grep -m1 '^status:' "$spec_file" | sed 's/^status:\s*//' | tr -d '[:space:]')
          if [ -n "$file_status" ] && [ "$roadmap_status" != "$file_status" ]; then
            error "ROADMAP says $fid='$roadmap_status' but $spec_file says status='$file_status'"
          fi
        fi
      fi
    fi

    # Completed table rows: completed features should have status: done
    if [ "$in_completed" -eq 1 ]; then
      fid=$(echo "$line" | grep -oP '^\|\s*F\d+' | tr -d '| ' || true)
      if [ -n "$fid" ]; then
        spec_file=$(find docs/features -name "${fid}-*" -o -name "${fid,,}-*" 2>/dev/null | head -1)
        if [ -n "$spec_file" ] && [ -f "$spec_file" ]; then
          file_status=$(grep -m1 '^status:' "$spec_file" | sed 's/^status:\s*//' | tr -d '[:space:]')
          if [ -n "$file_status" ] && [ "$file_status" != "done" ]; then
            error "ROADMAP completed table has $fid but $spec_file status='$file_status' (expected 'done')"
          fi
        fi
      fi
    fi
  done < "$ROADMAP"
fi

# --- Summary ---
if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo -e "${RED}check-docs: $ERRORS error(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}check-docs: all checks passed${NC}"
  exit 0
fi
