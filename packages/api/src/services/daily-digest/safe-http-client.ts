import { lookup } from "node:dns/promises"
import type { SafeHttpClient, SafeHttpErrorKind, SafeHttpFetchOptions } from "./types"

/**
 * F037 出站 HTTP 安全合同（AC10，德彪 Design Gate r1 P1-1）：
 * 仅 http/https；禁 userinfo；非常规端口拒；host 白名单（完整枚举为主，受控后缀例外）；
 * 每跳请求前解析全部 A/AAAA 并按 IANA special-use 精确段拒绝；关闭自动 redirect、
 * 逐跳重做全套校验（≤3 跳）；响应体流式累读设解压后上限；超时 abort。
 *
 * 已知残余（合同内声明）：DNS 预检与 fetch 自身解析之间存在 TOCTOU 窗口，未做 IP 钉死
 * （需自定义 undici connect，Phase 1 范围外）；预检拒绝全部 special-use 段已消除主要 rebinding 面。
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_REDIRECTS = 3

export class SafeHttpError extends Error {
  readonly kind: SafeHttpErrorKind
  readonly url: string
  constructor(kind: SafeHttpErrorKind, url: string, detail?: string) {
    super(`SafeHttp[${kind}] ${url}${detail ? ` — ${detail}` : ""}`)
    this.name = "SafeHttpError"
    this.kind = kind
    this.url = url
  }
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

function inV4Range(ip: number, base: string, prefix: number): boolean {
  const b = parseIpv4(base)
  if (b === null) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ip & mask) === (b & mask)
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
]

/** 展开 IPv6 到 8 组 16bit；含内嵌 IPv4 尾巴的先转两组。失败返回 null。 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf("%")
  if (zone !== -1) s = s.slice(0, zone)
  // 内嵌 IPv4 尾巴 → 转 hex 两组
  const v4tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4tail) {
    const v4 = parseIpv4(v4tail[2])
    if (v4 === null) return null
    s = `${v4tail[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const dbl = s.split("::")
  if (dbl.length > 2) return null
  const head = dbl[0] ? dbl[0].split(":") : []
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (dbl.length === 2 && missing < 0) return null
  if (dbl.length === 1 && head.length !== 8) return null
  const groupsHex = dbl.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head
  const groups: number[] = []
  for (const g of groupsHex) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    groups.push(Number.parseInt(g, 16))
  }
  return groups
}

/** IANA special-use 精确段（设计合同 v2）。解析失败视为 blocked（fail-closed）。 */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) {
    const g = expandIpv6(ip)
    if (!g) return true
    const [g0, g1, , , , g5, g6, g7] = g
    const allZero = (from: number, to: number) => g.slice(from, to + 1).every((x) => x === 0)
    // :: / ::1
    if (allZero(0, 6) && (g7 === 0 || g7 === 1)) return true
    // ::ffff:v4 mapped
    if (allZero(0, 4) && g5 === 0xffff)
      return isBlockedIp(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`)
    // 64:ff9b::/96 NAT64
    if (g0 === 0x64 && g1 === 0xff9b && allZero(2, 5))
      return isBlockedIp(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`)
    if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
    if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
    if (g0 === 0x2001 && g1 === 0x0db8) return true // doc
    return false
  }
  const v4 = parseIpv4(ip)
  if (v4 === null) return true
  return BLOCKED_V4.some(([base, prefix]) => inV4Range(v4, base, prefix))
}

export interface SafeHttpClientOptions {
  /** 完整 host 枚举（小写比较） */
  allowedHosts: string[]
  /** 受控后缀例外：仅对自有/明确可控域使用，匹配要求点边界 */
  allowedSuffixes?: string[]
  /** 测试注入；默认 node:dns lookup all */
  resolveDns?: (host: string) => Promise<string[]>
  /** 测试注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  maxRedirects?: number
  /**
   * 显式信任锚（如自建 RSSHub `http://192.168.1.5:1200`）：命中 origin 的那一跳跳过
   * 端口/DNS/IP 检查（scheme/userinfo 仍查）。**只允许来自 .env 人工配置**（Iron Law §3），
   * 绝不从 feed 内容注入；redirect 离开信任 origin 立即恢复全套校验。
   */
  trustedBaseUrls?: string[]
}

async function defaultResolveDns(host: string): Promise<string[]> {
  const recs = await lookup(host, { all: true })
  return recs.map((r) => r.address)
}

function validateUrl(
  raw: string,
  allowedHosts: Set<string>,
  suffixes: string[],
  hop: boolean,
): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new SafeHttpError(hop ? "redirect_invalid" : "network", raw, "invalid url")
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeHttpError("scheme", raw)
  if (u.username || u.password) throw new SafeHttpError("userinfo", raw)
  if (u.port && u.port !== (u.protocol === "https:" ? "443" : "80"))
    throw new SafeHttpError("port", raw)
  const host = u.hostname.toLowerCase()
  const ok = allowedHosts.has(host) || suffixes.some((s) => host === s || host.endsWith(`.${s}`))
  if (!ok) throw new SafeHttpError("host_not_allowed", raw, host)
  return u
}

export function createSafeHttpClient(options: SafeHttpClientOptions): SafeHttpClient {
  const allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()))
  const suffixes = (options.allowedSuffixes ?? []).map((s) => s.toLowerCase())
  const resolveDns = options.resolveDns ?? defaultResolveDns
  const fetchImpl = options.fetchImpl ?? fetch
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const trustedOrigins = new Set(
    (options.trustedBaseUrls ?? []).flatMap((b) => {
      try {
        return [new URL(b).origin.toLowerCase()]
      } catch {
        return []
      }
    }),
  )

  async function fetchText(url: string, opts: SafeHttpFetchOptions = {}): Promise<string> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const signal = AbortSignal.timeout(timeoutMs)

    let current = url
    for (let hop = 0; ; hop += 1) {
      // 信任锚逐跳判定：仅当本跳 origin 精确命中 .env 配置的信任 origin 才放行私网/端口
      let trustedHop = false
      try {
        trustedHop = trustedOrigins.has(new URL(current).origin.toLowerCase())
      } catch {
        trustedHop = false
      }
      let u: URL
      if (trustedHop) {
        u = new URL(current)
        if (u.protocol !== "https:" && u.protocol !== "http:")
          throw new SafeHttpError("scheme", current)
        if (u.username || u.password) throw new SafeHttpError("userinfo", current)
      } else {
        u = validateUrl(current, allowedHosts, suffixes, hop > 0)
        // IP 字面量直接判；域名解析全部记录判（任一命中即拒）
        const literal = /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")
        const hostForDns = u.hostname.replace(/^\[|\]$/g, "")
        const addrs = literal ? [hostForDns] : await resolveDns(hostForDns).catch(() => [])
        if (addrs.length === 0) throw new SafeHttpError("network", current, "dns resolution failed")
        for (const a of addrs) {
          if (isBlockedIp(a)) throw new SafeHttpError("ip_blocked", current, a)
        }
      }

      let res: Response
      try {
        // method/body 扩展（#31 小红书 sidecar MCP）：不改任何校验环节——host/端口/DNS/IP/
        // redirect 全链与 GET 同判。3xx 跳转会以同 method+body 重发（MCP 场景走信任锚无跳转）
        const method = opts.method ?? "GET"
        res = await fetchImpl(u.toString(), {
          method,
          ...(method === "POST" && opts.body !== undefined ? { body: opts.body } : {}),
          redirect: "manual",
          signal,
          headers: {
            // 完整浏览器 UA：部分源（Yahoo）对 bot 型 UA 直接 403（2026-07-03 smoke 实测）
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            ...opts.headers,
          },
        })
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
          throw new SafeHttpError("timeout", current)
        }
        throw new SafeHttpError("network", current, String(err))
      }

      if (res.status >= 300 && res.status < 400) {
        if (hop >= maxRedirects) throw new SafeHttpError("redirect_limit", current)
        const loc = res.headers.get("location")
        if (!loc) throw new SafeHttpError("redirect_invalid", current, "3xx without location")
        current = new URL(loc, u).toString()
        continue
      }
      if (!res.ok) throw new SafeHttpError("http_status", current, `status ${res.status}`)

      // 流式累读 + 解压后大小上限
      const reader = res.body?.getReader()
      if (!reader) return ""
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        let step: Awaited<ReturnType<typeof reader.read>>
        try {
          step = await reader.read()
        } catch (err) {
          if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
            throw new SafeHttpError("timeout", current)
          }
          throw new SafeHttpError("network", current, String(err))
        }
        if (step.done) break
        total += step.value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new SafeHttpError("too_large", current, `> ${maxBytes} bytes`)
        }
        chunks.push(step.value)
      }
      const buf = new Uint8Array(total)
      let off = 0
      for (const c of chunks) {
        buf.set(c, off)
        off += c.byteLength
      }
      return new TextDecoder("utf-8").decode(buf)
    }
  }

  return { fetchText }
}
