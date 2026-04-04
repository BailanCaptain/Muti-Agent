#!/bin/bash
# mount-skills.sh — 幂等地将 multi-agent-skills/ 下的 skill 目录
# 以 symlink 形式挂载到三个 CLI 的 skills 目录。
#
# Usage: bash scripts/mount-skills.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/multi-agent-skills"

CLAUDE_DIR="$REPO_ROOT/.claude/skills"
GEMINI_DIR="$REPO_ROOT/.gemini/skills"
AGENTS_DIR="$REPO_ROOT/.agents/skills"

# Ensure target directories exist
mkdir -p "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"

mounted=0
skipped=0

for skill_dir in "$SKILLS_SRC"/*/; do
  [ ! -d "$skill_dir" ] && continue
  name=$(basename "$skill_dir")

  # Skip if no SKILL.md
  if [ ! -f "$skill_dir/SKILL.md" ]; then
    echo "SKIP  $name (no SKILL.md)"
    skipped=$((skipped + 1))
    continue
  fi

  # Relative symlink target (from CLI skills dir → source)
  rel_target="../../multi-agent-skills/$name"

  for target_dir in "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"; do
    link_path="$target_dir/$name"

    # Remove existing (real dir or stale symlink)
    if [ -e "$link_path" ] || [ -L "$link_path" ]; then
      rm -rf "$link_path"
    fi

    ln -s "$rel_target" "$link_path"
  done

  echo "MOUNT $name"
  mounted=$((mounted + 1))
done

echo ""
echo "Done: $mounted mounted, $skipped skipped."
