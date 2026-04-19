import path from "node:path"

export type ApiConfig = {
  port: number
  host: string
  corsOrigin: string
  apiBaseUrl: string
  sqlitePath: string
  redisUrl: string
  uploadsDir: string
  runtimeEventsDir: string
}

export function buildApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 8787)
  return {
    port,
    host: env.API_HOST ?? "::",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:3000",
    apiBaseUrl: env.API_BASE_URL ?? `http://localhost:${port}`,
    sqlitePath: env.SQLITE_PATH ?? path.join(process.cwd(), "data", "multi-agent.sqlite"),
    redisUrl: env.REDIS_URL ?? "",
    uploadsDir: env.UPLOADS_DIR ?? path.join(process.cwd(), ".runtime", "uploads"),
    runtimeEventsDir:
      env.RUNTIME_EVENTS_DIR ?? path.join(process.cwd(), ".runtime", "runtime-events"),
  }
}

export const apiConfig: ApiConfig = buildApiConfig()
