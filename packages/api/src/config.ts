import path from "node:path"

export const apiConfig = {
  port: Number(process.env.API_PORT ?? 8787),
  host: process.env.API_HOST ?? "::",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${Number(process.env.API_PORT ?? 8787)}`,
  sqlitePath:
    process.env.SQLITE_PATH ??
    path.join(
      process.cwd(),
      "data",
      process.env.NODE_ENV === "production" ? "multi-agent.prod.sqlite" : "multi-agent.dev.sqlite"
    ),
  redisUrl: process.env.REDIS_URL ?? ""
}
