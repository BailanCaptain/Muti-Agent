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

# ── Reparse-point detection (Windows) ──────────────────────────────────
# Junctions/symlinks on Windows are detected via PowerShell. Probing each
# path with its own `powershell` process is O(skills × dirs) spawns (~300 for
# --prune) and measured ~87s on a real repo — blowing the worktree-preview
# spawn's 120s readiness budget (`dev:api` starts with this script, so the api
# never bound and the log stayed empty). Instead list every reparse point in a
# directory with ONE powershell call, cached per dir (lazy). ~300 spawns → 3,
# ~87s → ~3s.
#
# The cache captures each directory's state at first access and is NOT mutated
# when links are created later this run. That stays correct because: (a) Phase 1
# checks each (dir, skill) once, against the start state; (b) any link created
# in Phase 1 points at an existing skill (never dangling), and Phase 2 prune
# only ever acts on cached links whose target is gone — so a freshly created
# link being absent from the cache means Phase 2 leaves it, which is correct.
#
# Membership is keyed by the FULL path ("$dir/$name"), not a packed string —
# exact-match avoids false positives from names that are word-substrings of each
# other (e.g. a junction "foo bar" must not match a plain skill "bar"). Names are
# dir entries, so the full path is a unique key.
#
# Assoc arrays need bash 4+; only the Windows branch uses them (Unix is_link uses
# [ -L ]), so guard the declaration to keep this script working on bash 3.2 (macOS).
if is_windows; then
  declare -A _REPARSE_LOADED   # dir → "1" once that dir has been probed
  declare -A _REPARSE_SET      # "$dir/$name" → "1" for each reparse-point child
fi

load_reparse_cache() {
  local dir="$1"
  [ -n "${_REPARSE_LOADED[$dir]:-}" ] && return 0
  # Non-existent dir = no junctions (mount will create it); not a probe failure.
  if [ ! -d "$dir" ]; then _REPARSE_LOADED[$dir]=1; return 0; fi
  local win_dir names n
  win_dir=$(cygpath -w "$dir")
  # Capture PowerShell's own exit code: empty output is valid (no junctions), but
  # a *failed* probe must NOT be cached as "no junctions" — that would rebuild real
  # links and let dangling ones escape --prune (and rm -rf a misjudged junction).
  # Fail loud instead of relying on `set -e` (is_link runs in if/&& where errexit
  # is suppressed). No `2>/dev/null` so the failure is diagnosable.
  if ! names=$(powershell -NoProfile -NonInteractive -InputFormat None -Command \
    "Get-ChildItem -LiteralPath '$win_dir' -Force -ErrorAction SilentlyContinue | Where-Object { \$_.Attributes -match 'ReparsePoint' } | Select-Object -ExpandProperty Name"); then
    echo "mount-skills: PowerShell reparse-point probe failed for: $dir" >&2
    exit 1
  fi
  while IFS= read -r n; do
    n="${n%$'\r'}"   # strip trailing CR from PowerShell's CRLF output
    [ -n "$n" ] && _REPARSE_SET["$dir/$n"]=1
  done <<< "$names"
  _REPARSE_LOADED[$dir]=1   # only after a successful probe
  return 0                  # empty dir: the while loop's last status would be 1
}

# Check if a path is a junction/symlink (not a plain directory copy)
is_link() {
  local p="$1"
  if is_windows; then
    # Parameter expansion (not dirname) — is_link runs once per (skill × dir); a
    # subprocess spawn each adds ~15s on Windows for a full repo. link paths are
    # always absolute, so "${p%/*}" is the containing dir.
    load_reparse_cache "${p%/*}"
    [ -n "${_REPARSE_SET[$p]:-}" ]
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
    powershell -NoProfile -NonInteractive -InputFormat None -Command \
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
  name="${skill_dir%/}"; name="${name##*/}"

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
        name="${link##*/}"
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
