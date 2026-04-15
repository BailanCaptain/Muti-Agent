import { apiConfig } from "../config"

const EXCLUDED_PORTS = [
  apiConfig.port,
  3000, // Next.js frontend
]

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])
const PORT_MIN = 1024
const PORT_MAX = 65535

export interface PortValidationResult {
  allowed: boolean
  reason?: string
}

export function collectRuntimePorts(): number[] {
  const envKeys = ["API_PORT", "FRONTEND_PORT", "MCP_SERVER_PORT", "PREVIEW_GATEWAY_PORT"]
  const ports: number[] = []
  for (const key of envKeys) {
    const val = process.env[key]
    if (val) {
      const n = Number.parseInt(val, 10)
      if (n > 0 && n <= 65535) ports.push(n)
    }
  }
  return ports
}

export function validatePort(
  rawPort: number | string,
  opts: {
    host?: string
    gatewaySelfPort?: number
    runtimePorts?: number[]
    excludedPorts?: number[]
  } = {},
): PortValidationResult {
  const port = typeof rawPort === "string" ? Number.parseInt(rawPort, 10) : rawPort
  if (!Number.isFinite(port)) {
    return { allowed: false, reason: "Port must be a valid number" }
  }

  const { host, gatewaySelfPort, runtimePorts } = opts
  const excluded = [...EXCLUDED_PORTS, ...(opts.excludedPorts ?? []), ...(runtimePorts ?? [])]

  if (host && !LOOPBACK_HOSTS.has(host)) {
    return { allowed: false, reason: `Only loopback hosts allowed (got: ${host})` }
  }

  if (port < PORT_MIN || port > PORT_MAX) {
    return { allowed: false, reason: `Port must be in range ${PORT_MIN}-${PORT_MAX}` }
  }

  if (gatewaySelfPort && port === gatewaySelfPort) {
    return { allowed: false, reason: "Cannot proxy to gateway self port (recursive proxy)" }
  }

  if (excluded.includes(port)) {
    return { allowed: false, reason: `Port ${port} is excluded (service port)` }
  }

  return { allowed: true }
}
