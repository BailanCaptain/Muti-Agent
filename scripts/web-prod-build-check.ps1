# F040: decide whether the Next.js production bundle needs rebuilding before `next start`.
#
# Exit 1 = rebuild needed, exit 0 = current. Called by start-project.bat.
#
# We serve web as a production build (minified + gzipped, ~300KB first paint) instead of dev
# (~6MB uncompressed), so the phone can load it over a slow Tailscale relay. To keep normal
# restarts fast, we only run `next build` when frontend source changed since the last build --
# tracked by the mtime of .runtime\web-prod-build.stamp (written by start-project after a
# successful build). Backend-only changes don't touch these dirs, so they skip the rebuild.
$ErrorActionPreference = 'SilentlyContinue'

$stamp = '.runtime\web-prod-build.stamp'

# No production build present (fresh checkout, or .next is a leftover dev build) -> must build.
if (-not (Test-Path '.next\BUILD_ID')) { exit 1 }
# Never built in prod mode by us (stamp is our own marker) -> build so the stamp becomes truthful.
if (-not (Test-Path $stamp)) { exit 1 }

$stampTime = (Get-Item $stamp).LastWriteTime

# A `next dev` run since our last prod build contaminates .next (BUILD_ID stays but artifacts are
# dev), and `next start` would then fail. .next\dev's mtime tracks the last dev run; if it is newer
# than our stamp, dev ran after we built -> rebuild for a clean production .next. (If it's older,
# it's a harmless leftover and next start ignores it.)
if (Test-Path '.next\dev') {
  if ((Get-Item '.next\dev').LastWriteTime -gt $stampTime) { exit 1 }
}

$newest = Get-ChildItem -Recurse -File app, components, lib, packages\shared\src, next.config.ts, package.json |
  Where-Object { $_.Extension -in '.ts', '.tsx', '.css', '.js', '.mjs', '.json' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($newest -and $newest.LastWriteTime -gt $stampTime) { exit 1 }
exit 0
