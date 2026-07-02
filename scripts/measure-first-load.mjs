#!/usr/bin/env node
// F035 · 首屏 bundle 基线测量（Turbopack build 后运行）
// 用法：node scripts/measure-first-load.mjs [route]   （route 默认 "/"，需先 next build）
// 原理：Next 16 Turbopack 不再打印 per-route First Load JS（上游已知回退），
//       改从 .next/server/app/<route>/index.html 预渲染产物提取 chunk 引用清单。
// 口径（德彪 r1 P2）：扫描整份 HTML 的 /_next/static/chunks/*.js 引用（含 <script>、
//       preload、RSC payload 引用），是「HTML 声明/引用的首屏 JS」保守口径，
//       上界≈浏览器真实加载。所有尺寸单位为 KiB（1024 bytes）。
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const route = process.argv[2] ?? "/";
const nextDir = join(process.cwd(), ".next");
const htmlPath =
  route === "/"
    ? join(nextDir, "server/app/index.html")
    : join(nextDir, "server/app", route.replace(/^\//, ""), "index.html");
if (!existsSync(htmlPath)) {
  console.error(`找不到 ${htmlPath} — 先跑 pnpm build（且该路由需为静态预渲染）`);
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf8");
const chunkNames = [...html.matchAll(/\/_next\/static\/chunks\/([\w\-.]+\.js)/g)]
  .map((m) => m[1]);
const unique = [...new Set(chunkNames)];

// fail-fast（德彪 r1 P2）：抓不到任何 chunk = HTML 形态变了/提取正则失效，
// 此时 0 KiB + exit 0 是假绿，必须显式失败
if (unique.length === 0) {
  console.error(`❌ 从 ${htmlPath} 提取到 0 个 chunk 引用 — Next HTML 形态可能已变化，提取正则需要更新`);
  process.exit(1);
}

const chunksDir = join(nextDir, "static/chunks");
const rows = unique.map((name) => {
  const buf = readFileSync(join(chunksDir, name));
  return { name, raw: buf.length, gzip: gzipSync(buf).length };
});
rows.sort((a, b) => b.raw - a.raw);

const kib = (n) => (n / 1024).toFixed(1).padStart(9);
console.log(`route: ${route}`);
console.log("chunk".padEnd(36) + "raw KiB".padStart(9) + "gz KiB".padStart(9));
for (const r of rows) console.log(r.name.padEnd(36) + kib(r.raw) + kib(r.gzip));
const totRaw = rows.reduce((s, r) => s + r.raw, 0);
const totGz = rows.reduce((s, r) => s + r.gzip, 0);
console.log("TOTAL first-load JS".padEnd(36) + kib(totRaw) + kib(totGz));

const all = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
const allRaw = all.reduce((s, f) => s + readFileSync(join(chunksDir, f)).length, 0);
console.log(`\nall ${all.length} JS chunks raw: ${(allRaw / 1024).toFixed(1)} KiB | first-load 占比 ${((totRaw / allRaw) * 100).toFixed(1)}%`);

// F035 预算门：首屏 gzip 超预算时非零退出，可挂 CI / 手动巡检
const BUDGET_GZIP_KIB = 400;
const gzKib = totGz / 1024;
if (gzKib > BUDGET_GZIP_KIB) {
  console.error(`\n❌ 超预算：first-load gzip ${gzKib.toFixed(1)} KiB > ${BUDGET_GZIP_KIB} KiB（F035 预算）— 重开代码分割评估`);
  process.exit(2);
}
console.log(`\n✅ 预算内：first-load gzip ${gzKib.toFixed(1)} KiB ≤ ${BUDGET_GZIP_KIB} KiB（F035 预算）`);
