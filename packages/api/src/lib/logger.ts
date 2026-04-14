import type { FastifyBaseLogger } from "fastify"
import pino from "pino"

let _rootLogger: FastifyBaseLogger | null = null

export function setRootLogger(logger: FastifyBaseLogger) {
  _rootLogger = logger
}

export function createLogger(scope: string): FastifyBaseLogger {
  if (!_rootLogger) {
    const fallback = pino({ level: "silent" }) as unknown as FastifyBaseLogger
    return fallback.child({ scope })
  }
  return _rootLogger.child({ scope })
}
