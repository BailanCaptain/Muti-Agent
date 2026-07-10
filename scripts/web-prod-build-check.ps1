# F040: decide whether the Next.js production bundle needs rebuilding before `next start`.
#
# Exit 1 = rebuild needed, exit 0 = current. Called by start-project.bat.
#
# GIT-BASED, not a filesystem walk. PowerShell 5.1's `Get-ChildItem -Recurse` can hang while
# enumerating certain trees (it stalled startup on 2026-07-10 -- a recursion trap even with no
# visible reparse points), so we never walk files. The stamp holds the git commit the bundle was
# built from; we rebuild only when FRONTEND paths differ between that commit and HEAD. Backend-only
# commits move HEAD but don't touch these paths, so they skip the rebuild. Uncommitted frontend
# edits are NOT detected (the main runtime's frontend changes arrive via git pull/merge); delete
# .runtime\web-prod-build.stamp to force a rebuild if you ever hand-edit frontend here.
$ErrorActionPreference = 'SilentlyContinue'

$stamp = '.runtime\web-prod-build.stamp'

# No production build present (fresh checkout, or .next is a leftover dev build) -> must build.
if (-not (Test-Path '.next\BUILD_ID')) { exit 1 }
# Never built by us / empty stamp -> build so the stamp becomes truthful.
if (-not (Test-Path $stamp)) { exit 1 }
$built = (Get-Content $stamp -Raw).Trim()
if (-not $built) { exit 1 }

# git should be on PATH (start-project.bat prepends Git\bin). If it isn't, don't loop-build every
# start -- trust the existing bundle.
$head = (& git rev-parse HEAD 2>$null | Out-String).Trim()
if (-not $head) { exit 0 }
if ($built -eq $head) { exit 0 }

# Rebuild only when a frontend input changed between the built commit and HEAD. A non-existent
# pathspec entry is silently ignored by git; a bad/rebased $built makes `git diff` error (non-zero)
# -> we rebuild, the safe default.
& git diff --quiet $built $head -- app components lib packages/shared/src next.config.ts postcss.config.mjs tailwind.config.ts package.json 2>$null
if ($LASTEXITCODE -eq 0) { exit 0 }
exit 1
