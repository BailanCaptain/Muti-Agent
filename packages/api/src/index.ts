import { apiConfig } from "./config"
import { registerGracefulShutdown } from "./runtime/shutdown"
import { createApiServer } from "./server"

async function main() {
  const app = await createApiServer({
    apiBaseUrl: apiConfig.apiBaseUrl,
    sqlitePath: apiConfig.sqlitePath,
    corsOrigin: apiConfig.corsOrigin,
    redisUrl: apiConfig.redisUrl
  })

  registerGracefulShutdown({
    close: async () => {
      await app.close()
    }
  })

  await app.listen({
    port: apiConfig.port,
    host: apiConfig.host
  })
}

void main()
