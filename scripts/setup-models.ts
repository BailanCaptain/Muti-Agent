// B019: 一次性下载 Xenova/all-MiniLM-L6-v2 权重到 models/
//
// 仅供首次/更新模型时手动跑：`pnpm tsx scripts/setup-models.ts`
// 不在常规启动路径上。常规运行只读已 commit 的 models/ 目录。
//
// 设计要点（B019 Spike 验证后定）：
//   1. 不走 @huggingface/transformers 的 fetch — undici 默认 10s connectTimeout
//      在大陆撞 huggingface.co/hf-mirror.com 都会卡临界（curl 12s 能通但 undici 超时）。
//   2. 直接用 fetch + AbortController（90s 超时）拉文件到 models/Xenova/all-MiniLM-L6-v2/。
//   3. 默认 host: https://hf-mirror.com（大陆友好），可用 HF_ENDPOINT 覆盖。
//   4. 只下载默认推理需要的最小集（quantized int8 ONNX 22MB + tokenizer 712KB + 4 个 small json/txt）。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"

// 大陆环境多走本地代理（HTTP_PROXY/HTTPS_PROXY env），Node fetch 默认不读这些 env，
// 必须显式用 EnvHttpProxyAgent 才能 honor proxy 配置。同时把 connectTimeout 提到 60s。
// 没设代理也安全 — EnvHttpProxyAgent 退化为普通 Agent。
setGlobalDispatcher(new EnvHttpProxyAgent({ connect: { timeout: 60_000 } }))

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const modelsDir = path.join(projectRoot, "models", "Xenova", "all-MiniLM-L6-v2")

const MODEL_HOST = process.env.HF_ENDPOINT ?? "https://hf-mirror.com"
const MODEL_REPO = "Xenova/all-MiniLM-L6-v2"
const REVISION = "main"

// transformers.js v3 默认 dtype='fp32' 找 onnx/model.onnx (~80MB).
// 我们用 dtype='q8' (quantized int8 22MB) — 精度差 <1%, 仓库 size 4x 友好.
// pipelineLoader 调用时显式传 { dtype: 'q8' } 匹配本目录文件.
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "vocab.txt",
  "onnx/model_quantized.onnx",
]

const FETCH_TIMEOUT_MS = 90_000

async function downloadFile(relPath: string): Promise<void> {
  const url = `${MODEL_HOST}/${MODEL_REPO}/resolve/${REVISION}/${relPath}`
  const dest = path.join(modelsDir, relPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(dest, buf)
    const size = (buf.length / 1024).toFixed(buf.length < 1024 * 1024 ? 1 : 0)
    const unit = buf.length < 1024 * 1024 ? "KB" : "KB"
    console.log(`  ✓ ${relPath} (${size} ${unit}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function main() {
  console.log(`[setup-models] host=${MODEL_HOST}`)
  console.log(`[setup-models] repo=${MODEL_REPO}@${REVISION}`)
  console.log(`[setup-models] dest=${modelsDir}`)
  console.log(`[setup-models] downloading ${FILES.length} files (~23MB)...`)

  fs.mkdirSync(modelsDir, { recursive: true })

  const t0 = Date.now()
  for (const f of FILES) {
    await downloadFile(f)
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[setup-models] done in ${elapsed}s`)
}

main().catch((err) => {
  console.error("[setup-models] FAILED:", err.message ?? err)
  if (err.cause) console.error("  cause:", err.cause)
  process.exit(1)
})
