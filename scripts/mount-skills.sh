#!/bin/bash
# mount-skills.sh — 幂等地将 multi-agent-skills/ 下的 skill 目录
# 以 junction/symlink 形式挂载到三个 CLI 的 skills 目录。
# Windows 使用 directory junction（PowerShell New-Item -Junction），Unix 使用 symlink。
#
# Usage: bash scripts/mount-skills.sh [--force] [--prune]
#   --force  清除所有现有 skill 目录后重建（用于修复旧的文件拷贝）
#   --prune  额外清理 dangling symlink（target 在 multi-agent-skills/ 不存在）
#
# Env override (for tests):
#   REPO_ROOT=/tmp/xxx bash scripts/mount-skills.sh
#     → 用 REPO_ROOT 作为根，而不是脚本所在目录的父目录。

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SKILLS_SRC="$REPO_ROOT/multi-agent-skills"

CLAUDE_DIR="$REPO_ROOT/.claude/skills"
GEMINI_DIR="$REPO_ROOT/.gemini/skills"
AGENTS_DIR="$REPO_ROOT/.agents/skills"

FORCE=false
PRUNE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --prune) PRUNE=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Detect Windows (Git Bash / MSYS / Cygwin)
is_windows() {
  [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* || "$OSTYPE" == win* ]]
}

# Check if a path is a junction/symlink (not a plain directory copy)
is_link() {
  local p="$1"
  if is_windows; then
    local win_parent
    win_parent=$(cygpath -w "$(dirname "$p")")
    powershell -NoProfile -Command \
      "(Get-Item -LiteralPath '$win_parent\\$(basename "$p")' -Force -ErrorAction SilentlyContinue).Attributes -match 'ReparsePoint'" \
      2>/dev/null | grep -qi 'true'
  else
    [ -L "$p" ]
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
pruned=0

# ── Phase 1: Mount each skill from manifest source ─────────────────────
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

# ── Phase 2: Prune dangling symlinks (--prune or --force) ───────────────
# Dangling = symlink whose source dir no longer exists in multi-agent-skills/.
# Orphan (source exists but not in manifest) is flagged by check-skills but not pruned here.
if $FORCE || $PRUNE; then
  for target_dir in "$CLAUDE_DIR" "$GEMINI_DIR" "$AGENTS_DIR"; do
    [ ! -d "$target_dir" ] && continue
    shopt -s nullglob
    for link in "$target_dir"/*; do
      # Only consider symlinks/junctions
      if is_link "$link"; then
        name=$(basename "$link")
        if [ ! -d "$SKILLS_SRC/$name" ]; then
          # On Windows junctions need rmdir; Unix symlinks need rm. Try both.
          rm -f "$link" 2>/dev/null || true
          if [ -e "$link" ] || [ -L "$link" ]; then
            rmdir "$link" 2>/dev/null || rm -rf "$link"
          fi
          pruned=$((pruned + 1))
        fi
      fi
    done
    shopt -u nullglob
  done
fi

echo "Skills: $mounted mounted, $unchanged unchanged, $cleaned cleaned, $pruned pruned, $skipped skipped."
