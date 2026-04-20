import path from "node:path"

export type CorsOrigin = string | RegExp | (string | RegExp)[]

export type ApiConfig = {
  port: number
  host: string
  corsOrigin: CorsOrigin
  apiBaseUrl: string
  sqlitePath: string
  redisUrl: string
  uploadsDir: string
  runtimeEventsDir: string
}

// B018: dev 默认通配 localhost 任意端口，避免每新起一个 worktree preview 端口都要扩 CORS 白名单。
// 生产部署用 CORS_ORIGIN 显式设成严格 origin（单 string）或逗号分隔列表。
const LOCALHOST_ANY_REGEX = /^http:\/\/localhost:\d+$/

export function parseCorsOrigin(raw: string | undefined): CorsOrigin {
  const trimmed = (raw ?? "").trim()
  if (!trimmed || trimmed === "localhost-any") return LOCALHOST_ANY_REGEX
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return trimmed
}

export function buildApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 8787)
  return {
    port,
    host: env.API_HOST ?? "::",
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN),
    apiBaseUrl: env.API_BASE_URL ?? `http://localhost:${port}`,
    sqlitePath: env.SQLITE_PATH ?? path.join(process.cwd(), "data", "multi-agent.sqlite"),
    redisUrl: env.REDIS_URL ?? "",
    uploadsDir: env.UPLOADS_DIR ?? path.join(process.cwd(), ".runtime", "uploads"),
    runtimeEventsDir:
      env.RUNTIME_EVENTS_DIR ?? path.join(process.cwd(), ".runtime", "runtime-events"),
  }
}

export const apiConfig: ApiConfig = buildApiConfig()
