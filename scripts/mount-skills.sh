#!/bin/bash
# mount-skills.sh — 幂等地将 multi-agent-skills/ 下的 skill 目录
# 以 symlink 形式挂载到三个 CLI 的 skills 目录。
# 如果目标已存在且内容一致则跳过，避免每次重建拖慢启动。
#
# Usage: bash scripts/mount-skills.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/multi-agent-skills"

CLAUDE_DIR="$REPO_ROOT/.claude/skills"
GEMINI_DIR="$REPO_ROOT/.gemini/skills"
AGENTS_DIR="$REPO_ROOT/.agents/skills"

mkdir -p "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"

mounted=0
skipped=0
unchanged=0

for skill_dir in "$SKILLS_SRC"/*/; do
  [ ! -d "$skill_dir" ] && continue
  name=$(basename "$skill_dir")

  if [ ! -f "$skill_dir/SKILL.md" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  rel_target="../../multi-agent-skills/$name"

  for target_dir in "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"; do
    link_path="$target_dir/$name"

    # Quick check: if SKILL.md already accessible, skip
    if [ -f "$link_path/SKILL.md" ]; then
      unchanged=$((unchanged + 1))
      continue
    fi

    # Remove stale entry
    if [ -e "$link_path" ] || [ -L "$link_path" ]; then
      rm -rf "$link_path"
    fi

    ln -s "$rel_target" "$link_path"
    mounted=$((mounted + 1))
  done
done

if [ "$mounted" -gt 0 ]; then
  echo "Skills: $mounted mounted, $unchanged unchanged, $skipped skipped."
else
  echo "Skills: all up-to-date ($unchanged links ok)."
fi
