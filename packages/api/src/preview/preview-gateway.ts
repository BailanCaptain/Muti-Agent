import http from "node:http"
import { createGunzip, createInflate } from "node:zlib"
import httpProxy from "http-proxy"
import { BRIDGE_SCRIPT } from "./bridge-script"
import { validatePort } from "./port-validator"
import { buildWsPatchScript } from "./ws-patch-script"
import { createLogger } from "../lib/logger"

const log = createLogger("preview-gateway")

export interface PreviewGatewayOptions {
  port: number
  host?: string
  runtimePorts?: number[]
}

export class PreviewGateway {
  private server: http.Server
  private proxy: httpProxy
  private port: number
  private host: string
  private runtimePorts: number[]
  actualPort = 0

  constructor(opts: PreviewGatewayOptions) {
    this.port = opts.port
    this.host = opts.host ?? "127.0.0.1"
    this.runtimePorts = opts.runtimePorts ?? []

    this.proxy = httpProxy.createProxyServer({
      ws: true,
      xfwd: false,
      changeOrigin: true,
      selfHandleResponse: true,
    })

    this.proxy.on("error", (err: Error, _req: unknown, res: unknown) => {
      const r = res as http.ServerResponse | undefined
      if (r && "writeHead" in r && !r.headersSent) {
        r.writeHead(502, { "Content-Type": "application/json" })
        r.end(JSON.stringify({ error: "Proxy error", message: err.message }))
      } else if (res && typeof (res as { destroy?: () => void }).destroy === "function") {
        ;(res as { destroy: () => void }).destroy()
      }
    })

    this.proxy.on("proxyRes", (proxyRes: http.IncomingMessage, _req: http.IncomingMessage, res: http.ServerResponse) => {
      delete proxyRes.headers["x-frame-options"]
      const csp = proxyRes.headers["content-security-policy"]
      if (typeof csp === "string") {
        const cleaned = csp
          .split(";")
          .filter((d: string) => !d.trim().startsWith("frame-ancestors"))
          .join(";")
          .trim()
        if (cleaned) {
          proxyRes.headers["content-security-policy"] = cleaned
        } else {
          delete proxyRes.headers["content-security-policy"]
        }
      }

      const ct = (proxyRes.headers["content-type"] ?? "") as string
      if (!ct.includes("text/html")) {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
        proxyRes.pipe(res)
        return
      }

      const encoding = (proxyRes.headers["content-encoding"] ?? "") as string
      if (encoding && encoding !== "gzip" && encoding !== "deflate" && encoding !== "identity") {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
        proxyRes.pipe(res)
        return
      }

      const chunks: Buffer[] = []
      let stream: NodeJS.ReadableStream = proxyRes
      if (encoding === "gzip") {
        stream = proxyRes.pipe(createGunzip())
      } else if (encoding === "deflate") {
        stream = proxyRes.pipe(createInflate())
      }

      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      stream.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf-8")
        const targetPort = (_req as unknown as Record<string, unknown>).__previewTargetPort as number | undefined
        const wsPatch = targetPort ? buildWsPatchScript(targetPort) : ""
        const injection = wsPatch + BRIDGE_SCRIPT
        if (html.includes("</head>")) {
          html = html.replace("</head>", `${injection}</head>`)
        } else if (html.includes("<body")) {
          html = html.replace(/<body([^>]*)>/, `<body$1>${injection}`)
        } else {
          html = injection + html
        }
        const headers = { ...proxyRes.headers }
        delete headers["content-encoding"]
        delete headers["transfer-encoding"]
        const buf = Buffer.from(html, "utf-8")
        headers["content-length"] = String(buf.length)
        res.writeHead(proxyRes.statusCode ?? 200, headers)
        res.end(buf)
      })
      stream.on("error", () => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
        res.end(Buffer.concat(chunks))
      })
    })

    this.server = http.createServer((req, res) => {
      const parsed = this.parseTarget(req)
      if (!parsed) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Missing __preview_port query parameter" }))
        return
      }

      const validation = validatePort(parsed.port, {
        host: parsed.host,
        gatewaySelfPort: this.actualPort,
        runtimePorts: this.runtimePorts,
      })
      if (!validation.allowed) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: validation.reason }))
        return
      }

      ;(req as unknown as Record<string, unknown>).__previewTargetPort = parsed.port

      const url = new URL(req.url!, `http://${req.headers.host}`)
      url.searchParams.delete("__preview_port")
      url.searchParams.delete("__preview_host")
      req.url = url.pathname + (url.search === "?" ? "" : url.search)

      const target = `http://${parsed.host}:${parsed.port}`
      this.proxy.web(req, res, { target }, (err: Error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Proxy error", message: err.message }))
        }
      })
    })

    this.server.on("upgrade", (req, socket, head) => {
      const parsed = this.parseTarget(req)
      if (!parsed) {
        socket.destroy()
        return
      }
      const validation = validatePort(parsed.port, {
        host: parsed.host,
        gatewaySelfPort: this.actualPort,
        runtimePorts: this.runtimePorts,
      })
      if (!validation.allowed) {
        socket.destroy()
        return
      }
      const target = `http://${parsed.host}:${parsed.port}`
      socket.on("error", () => socket.destroy())
      this.proxy.ws(req, socket, head, { target })
    })
  }

  private parseTarget(req: http.IncomingMessage): { port: number; host: string } | null {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const portStr = url.searchParams.get("__preview_port")
    if (!portStr) return null
    const port = Number.parseInt(portStr, 10)
    if (Number.isNaN(port)) return null
    const host = url.searchParams.get("__preview_host") ?? "localhost"
    return { port, host }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.server.off("error", handleError)
        this.server.off("listening", handleListening)
      }
      const handleError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const handleListening = () => {
        cleanup()
        const addr = this.server.address() as { port: number } | null
        this.actualPort = addr?.port ?? 0
        log.info({ port: this.actualPort }, "Preview gateway started")
        resolve()
      }
      this.server.once("error", handleError)
      this.server.once("listening", handleListening)
      this.server.listen(this.port, this.host)
    })
  }

  async stop(): Promise<void> {
    this.proxy.close()
    if (!this.server.listening) return
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
