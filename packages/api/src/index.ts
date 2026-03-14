import { apiConfig } from "./config"
import { createApiServer } from "./server"

async function main() {
  const app = await createApiServer({
    apiBaseUrl: apiConfig.apiBaseUrl,
    sqlitePath: apiConfig.sqlitePath,
    corsOrigin: apiConfig.corsOrigin,
    redisUrl: apiConfig.redisUrl
  })

  await app.listen({
    port: apiConfig.port,
    host: apiConfig.host
  })
}

void main()
