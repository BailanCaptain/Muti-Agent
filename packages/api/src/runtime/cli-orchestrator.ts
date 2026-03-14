import { spawn } from "node:child_process"
import path from "node:path"
import readline from "node:readline"
import { existsSync, readFileSync } from "node:fs"
import type { Provider } from "@multi-agent/shared"

export type RunTurnOptions = {
  provider: Provider
  model: string | null
  nativeSessionId: string | null
  history: Array<{ role: "user" | "assistant"; content: string }>
  userMessage: string
  onAssistantDelta: (delta: string) => void
  onSession: (nativeSessionId: string) => void
  onModel: (model: string) => void
}

export type RunTurnResult = {
  content: string
  nativeSessionId: string | null
  currentModel: string | null
  stopped: boolean
}

function resolveNpmRoot() {
  const candidates = [
    path.join(process.env.APPDATA || "", "npm"),
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm")
  ]

  return candidates.find((candidate) => candidate && existsSync(candidate)) || ""
}

function readTextFileSafe(filePath: string) {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function resolveNodeScript(packageName: string, relativeScriptPath: string[]) {
  const npmRoot = resolveNpmRoot()
  const scriptPath = npmRoot ? path.join(npmRoot, "node_modules", packageName, ...relativeScriptPath) : ""

  if (scriptPath && existsSync(scriptPath)) {
    return {
      command: process.execPath,
      prefixArgs: [scriptPath],
      shell: false
    }
  }

  return {
    command: relativeScriptPath.at(-1)?.replace(/\.js$/, "") ?? packageName,
    prefixArgs: [],
    shell: true
  }
}

function resolveCodexCommand() {
  const npmRoot = resolveNpmRoot()
  const codexJs = npmRoot ? path.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js") : ""

  if (codexJs && existsSync(codexJs)) {
    return { command: process.execPath, prefixArgs: [codexJs], shell: false }
  }

  return { command: "codex.cmd", prefixArgs: [], shell: true }
}

function buildHistoryPrompt(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string
) {
  if (!history.length) {
    return userMessage
  }

  const transcript = history
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n\n")

  return [
    "Continue the conversation below.",
    "Keep the existing context and answer the final user message directly.",
    "",
    transcript,
    "",
    `User: ${userMessage}`
  ].join("\n")
}

function buildCommand(provider: Provider, prompt: string, nativeSessionId: string | null, model: string | null) {
  if (provider === "codex") {
    const runtime = resolveCodexCommand()
    const modelArgs = model ? ["-m", model] : []
    const baseArgs = nativeSessionId
      ? ["exec", "resume", "--skip-git-repo-check", "--json", nativeSessionId, prompt]
      : ["exec", "--skip-git-repo-check", "--json", prompt]

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...modelArgs, ...baseArgs],
      shell: runtime.shell
    }
  }

  if (provider === "claude") {
    const runtime = resolveNodeScript("@anthropic-ai/claude-code", ["cli.js"])
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"]
    if (model) {
      args.push("--model", model)
    }
    if (nativeSessionId) {
      args.push("--resume", nativeSessionId)
    }

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell
    }
  }

  const runtime = resolveNodeScript("@google/gemini-cli", ["dist", "index.js"])
  const args = ["-p", prompt, "--output-format", "stream-json"]
  if (model) {
    args.push("--model", model)
  }
  if (nativeSessionId) {
    args.push("--resume", nativeSessionId)
  }

  return {
    command: runtime.command,
    args: [...runtime.prefixArgs, ...args],
    shell: runtime.shell
  }
}

function findSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const value = payload as Record<string, unknown>
  if (typeof value.session_id === "string" && value.session_id) {
    return value.session_id
  }
  if (typeof value.sessionId === "string" && value.sessionId) {
    return value.sessionId
  }

  for (const child of Object.values(value)) {
    const nested = findSessionId(child)
    if (nested) {
      return nested
    }
  }

  return null
}

function parseAssistantDelta(provider: Provider, event: Record<string, unknown>) {
  if (provider === "codex") {
    const item = event.item as { type?: string; text?: string } | undefined
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      return item.text
    }
  }

  if (provider === "claude") {
    if (event.type === "assistant") {
      const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined
      return (
        message?.content
          ?.filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("") ?? ""
      )
    }
  }

  if (provider === "gemini") {
    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      return event.content
    }
  }

  return ""
}

export function runTurn(options: RunTurnOptions) {
  const prompt = options.nativeSessionId
    ? options.userMessage
    : buildHistoryPrompt(options.history, options.userMessage)
  const runtime = buildCommand(options.provider, prompt, options.nativeSessionId, options.model)
  const child = spawn(runtime.command, runtime.args, {
    shell: runtime.shell,
    stdio: ["ignore", "pipe", "pipe"]
  })

  let cancelled = false

  const promise = new Promise<RunTurnResult>((resolve, reject) => {
    let content = ""
    let currentModel = options.model
    let currentSessionId = options.nativeSessionId
    let stderr = ""

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })

    lines.on("line", (line) => {
      if (!line.trim()) {
        return
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>
        const delta = parseAssistantDelta(options.provider, event)
        const sessionId = findSessionId(event)

        if (delta) {
          content += delta
          options.onAssistantDelta(delta)
        }

        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId
          options.onSession(sessionId)
        }

        const eventModel =
          typeof event.model === "string"
            ? event.model
            : typeof (event.message as { model?: string } | undefined)?.model === "string"
              ? (event.message as { model: string }).model
              : null

        if (eventModel && eventModel !== currentModel) {
          currentModel = eventModel
          options.onModel(eventModel)
        }
      } catch {
        content += line
        options.onAssistantDelta(line)
      }
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => {
      if (cancelled) {
        resolve({
          content,
          nativeSessionId: currentSessionId,
          currentModel,
          stopped: true
        })
        return
      }

      if (code === 0) {
        resolve({
          content,
          nativeSessionId: currentSessionId,
          currentModel,
          stopped: false
        })
        return
      }

      reject(new Error(stderr.trim() || `${options.provider} exited with code ${code ?? "unknown"}`))
    })
  })

  return {
    cancel() {
      cancelled = true
      child.kill()
    },
    promise
  }
}
