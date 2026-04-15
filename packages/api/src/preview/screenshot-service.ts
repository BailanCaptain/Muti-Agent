import { execFile, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

function resolvePlaywrightNodeModules(): string {
  try {
    const resolved = require.resolve("playwright")
    const idx = resolved.lastIndexOf("node_modules")
    if (idx !== -1) return resolved.slice(0, idx + "node_modules".length)
  } catch { /* not directly resolvable */ }

  try {
    const out = execFileSync("node", ["-e", "process.stdout.write(require.resolve('playwright'))"], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, NODE_PATH: "" },
      shell: true,
    }).trim()
    if (out) {
      const idx = out.lastIndexOf("node_modules")
      if (idx !== -1) return out.slice(0, idx + "node_modules".length)
    }
  } catch { /* fallback below */ }

  try {
    const out = execFileSync("npx", ["--yes", "node", "-e", "process.stdout.write(require.resolve('playwright'))"], {
      encoding: "utf-8",
      timeout: 15000,
      shell: true,
    }).trim()
    if (out) {
      const idx = out.lastIndexOf("node_modules")
      if (idx !== -1) return out.slice(0, idx + "node_modules".length)
    }
  } catch { /* give up */ }

  return ""
}

const PLAYWRIGHT_SCRIPT = `
const { chromium } = require('playwright');
(async () => {
  const url = process.env._SS_URL || 'http://localhost:3000';
  const width = parseInt(process.env._SS_W || '1920', 10);
  const height = parseInt(process.env._SS_H || '1080', 10);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  const buffer = await page.screenshot({ type: 'png' });
  process.stdout.write(buffer.toString('base64'));
  await browser.close();
})().catch(e => { process.stderr.write(e.message); process.exit(1); });
`

export type ScreenshotResult = {
  url: string
  filename: string
  width: number
  height: number
}

export async function captureScreenshot(
  uploadsDir: string,
  targetUrl = "http://localhost:3000",
  width = 1920,
  height = 1080,
): Promise<ScreenshotResult> {
  const nodePath = resolvePlaywrightNodeModules()
  const { stdout } = await execFileAsync(
    process.execPath,
    ["-e", PLAYWRIGHT_SCRIPT],
    {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      env: {
        ...process.env,
        _SS_URL: targetUrl,
        _SS_W: String(width),
        _SS_H: String(height),
        ...(nodePath ? { NODE_PATH: nodePath } : {}),
      },
    },
  )

  const buffer = Buffer.from(stdout, "base64")
  mkdirSync(uploadsDir, { recursive: true })
  const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`
  writeFileSync(path.join(uploadsDir, filename), buffer)

  return { url: `/uploads/${filename}`, filename, width, height }
}
