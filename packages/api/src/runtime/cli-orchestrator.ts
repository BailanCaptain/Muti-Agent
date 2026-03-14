import crypto from "node:crypto";
import type { Provider } from "@multi-agent/shared";
import { buildHistoryPrompt, findSessionId, parseEventModel, type AgentRunInput } from "./base-runtime";
import { claudeRuntime } from "./claude-runtime";
import { codexRuntime } from "./codex-runtime";
import { geminiRuntime } from "./gemini-runtime";
import { buildSystemPrompt, formatSkillsForPrompt, loadSkillsForTask } from "../skills/loader";
import type { SkillIntent } from "../skills/matcher";

export type RunTurnOptions = {
  invocationId?: string;
  threadId: string;
  provider: Provider;
  agentId?: string;
  apiBaseUrl?: string;
  callbackToken?: string;
  model: string | null;
  nativeSessionId: string | null;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  skillIntent?: SkillIntent;
  onAssistantDelta: (delta: string) => void;
  onSession: (nativeSessionId: string) => void;
  onModel: (model: string) => void;
  onActivity?: (activity: { stream: "stdout" | "stderr"; at: string; chunk: string }) => void;
};

export type RunTurnResult = {
  content: string;
  nativeSessionId: string | null;
  currentModel: string | null;
  stopped: boolean;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
};

const runtimeAdapters = {
  codex: codexRuntime,
  claude: claudeRuntime,
  gemini: geminiRuntime
} as const;

export function runTurn(options: RunTurnOptions) {
  const basePrompt = options.nativeSessionId
    ? options.userMessage
    : buildHistoryPrompt(options.history, options.userMessage);
  // system prompt 每次都加载，task skill 只在命中对应任务意图时追加。
  const systemPrompt = buildSystemPrompt(options.agentId ?? options.provider);
  const skillsPrompt = formatSkillsForPrompt(
    loadSkillsForTask({
      message: options.userMessage,
      intent: options.skillIntent
    })
  );
  const prompt = skillsPrompt ? `${skillsPrompt}\n\n${basePrompt}` : basePrompt;
  const runtime = runtimeAdapters[options.provider];
  const input: AgentRunInput = {
    invocationId: options.invocationId ?? crypto.randomUUID(),
    threadId: options.threadId,
    agentId: options.agentId ?? options.provider,
    prompt,
    env: {
      // runtime 统一通过 env 接收运行期身份、模型、system prompt 等信息。
      MULTI_AGENT_SYSTEM_PROMPT: systemPrompt,
      CAT_ROOM_API_URL: options.apiBaseUrl ?? "",
      CAT_ROOM_INVOCATION_ID: options.invocationId ?? "",
      CAT_ROOM_CALLBACK_TOKEN: options.callbackToken ?? "",
      MULTI_AGENT_MODEL: options.model ?? "",
      MULTI_AGENT_NATIVE_SESSION_ID: options.nativeSessionId ?? ""
    }
  };
  let cancelled = false;
  let content = "";
  let currentModel = options.model;
  let currentSessionId = options.nativeSessionId;

  const handle = runtime.runStream(input, {
    onStdoutLine(line) {
      if (!line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const delta = runtime.parseAssistantDelta(event);
        const sessionId = findSessionId(event);
        const eventModel = parseEventModel(event);

        if (delta) {
          content += delta;
          options.onAssistantDelta(delta);
        }

        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          options.onSession(sessionId);
        }

        if (eventModel && eventModel !== currentModel) {
          currentModel = eventModel;
          options.onModel(eventModel);
        }
      } catch {
        // 某些 CLI 不会始终输出结构化 JSON；兜底时直接把原始文本当增量内容处理。
        content += line;
        options.onAssistantDelta(line);
      }
    },
    onActivity(activity) {
      options.onActivity?.(activity);
    }
  });

  return {
    cancel() {
      cancelled = true;
      handle.cancel();
    },
    promise: handle.promise.then((output) => ({
      content,
      nativeSessionId: currentSessionId,
      currentModel,
      stopped: cancelled,
      rawStdout: output.rawStdout,
      rawStderr: output.rawStderr,
      exitCode: output.exitCode
    }))
  };
}
