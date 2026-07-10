import type { SafeHttpClient } from "../../net/safe-http-client"

/**
 * F040 T12：飞书 tenant_access_token 管理（AC6）。
 * REST 全走注入的 SafeHttpClient（host pin open.feishu.cn，D9：SDK 只做 WS）。
 * 缓存 + 提前 300s 刷新 + 并发单飞 + invalidate（发送遇 token 失效时调）。
 */

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
const REFRESH_EARLY_MS = 300_000

export type FeishuTokenManagerDeps = {
  appId: string
  appSecret: string
  http: SafeHttpClient
  /** 注入 clock（ms epoch）；默认 Date.now */
  now?: () => number
}

export class FeishuTokenManager {
  private cached: string | null = null
  private expiresAtMs = 0
  private inflight: Promise<string> | null = null
  private readonly now: () => number

  constructor(private readonly deps: FeishuTokenManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  invalidate(): void {
    this.cached = null
    this.expiresAtMs = 0
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.expiresAtMs) return this.cached
    // 并发单飞：多个 caller 命中同一 fetch
    if (this.inflight) return this.inflight
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetchToken(): Promise<string> {
    const res = await this.deps.http.request(TOKEN_URL, {
      method: "POST",
      jsonBody: { app_id: this.deps.appId, app_secret: this.deps.appSecret },
    })
    let body: { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    try {
      body = JSON.parse(res.text)
    } catch {
      throw new Error(`Feishu token: non-JSON response (http ${res.status})`)
    }
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`Feishu token error code=${body.code} msg=${body.msg ?? "?"}`)
    }
    this.cached = body.tenant_access_token
    // 提前 300s 刷新（expire 单位秒）
    this.expiresAtMs = this.now() + (body.expire ?? 7200) * 1000 - REFRESH_EARLY_MS
    return this.cached
  }
}
