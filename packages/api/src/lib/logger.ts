import type { FastifyBaseLogger } from "fastify"

let _rootLogger: FastifyBaseLogger | null = null

export function setRootLogger(logger: FastifyBaseLogger) {
  _rootLogger = logger
}

export function createLogger(scope: string): FastifyBaseLogger {
  if (!_rootLogger) {
    throw new Error("Root logger not initialized — call setRootLogger() first")
  }
  return _rootLogger.child({ scope })
}
