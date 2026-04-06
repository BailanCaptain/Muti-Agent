#!/bin/bash
# mount-skills.sh — 幂等地将 multi-agent-skills/ 下的 skill 目录
# 以 junction/symlink 形式挂载到三个 CLI 的 skills 目录。
# Windows 使用 directory junction（PowerShell New-Item -Junction），Unix 使用 symlink。
#
# Usage: bash scripts/mount-skills.sh [--force]
#   --force  清除所有现有 skill 目录后重建（用于修复旧的文件拷贝）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/multi-agent-skills"

CLAUDE_DIR="$REPO_ROOT/.claude/skills"
GEMINI_DIR="$REPO_ROOT/.gemini/skills"
AGENTS_DIR="$REPO_ROOT/.agents/skills"

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

# Detect Windows (Git Bash / MSYS / Cygwin)
is_windows() {
  [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* || "$OSTYPE" == win* ]]
}

# Check if a path is a junction/symlink (not a plain directory copy)
is_link() {
  local path="$1"
  if is_windows; then
    local win_parent
    win_parent=$(cygpath -w "$(dirname "$path")")
    powershell -NoProfile -Command \
      "(Get-Item -LiteralPath '$win_parent\\$(basename "$path")' -Force -ErrorAction SilentlyContinue).Attributes -match 'ReparsePoint'" \
      2>/dev/null | grep -qi 'true'
  else
    [ -L "$path" ]
  fi
}

# Create a directory link: junction on Windows, symlink on Unix
make_link() {
  local target="$1"  # absolute path to source dir
  local link="$2"    # absolute path to link

  if is_windows; then
    local win_link win_target
    win_link=$(cygpath -w "$link")
    win_target=$(cygpath -w "$target")
    powershell -NoProfile -Command \
      "New-Item -ItemType Junction -Path '$win_link' -Target '$win_target' | Out-Null"
  else
    local rel_target
    rel_target=$(realpath --relative-to="$(dirname "$link")" "$target")
    ln -s "$rel_target" "$link"
  fi
}

mkdir -p "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"

mounted=0
skipped=0
unchanged=0
cleaned=0

for skill_dir in "$SKILLS_SRC"/*/; do
  [ ! -d "$skill_dir" ] && continue
  name=$(basename "$skill_dir")

  if [ ! -f "$skill_dir/SKILL.md" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  abs_target="$SKILLS_SRC/$name"

  for target_dir in "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"; do
    link_path="$target_dir/$name"

    # Already a correct junction/symlink? skip (unless --force)
    if ! $FORCE && is_link "$link_path" && [ -f "$link_path/SKILL.md" ]; then
      unchanged=$((unchanged + 1))
      continue
    fi

    # Remove stale entry (plain copy, broken link, or forced rebuild)
    if [ -e "$link_path" ] || [ -L "$link_path" ]; then
      rm -rf "$link_path"
      cleaned=$((cleaned + 1))
    fi

    make_link "$abs_target" "$link_path"
    mounted=$((mounted + 1))
  done
done

echo "Skills: $mounted mounted, $unchanged unchanged, $cleaned cleaned, $skipped skipped."
