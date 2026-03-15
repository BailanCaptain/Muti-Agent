import type { Provider } from "./constants";

/**
 * 时间线里的一条消息。
 * 这是前端真正拿来渲染聊天气泡的数据结构。
 */
export type TimelineMessage = {
  /** 这条消息自己的唯一 ID。前端用它定位气泡，后端用它做覆盖和增量更新。 */
  id: string;
  /** 这条消息属于哪一个 provider，例如 codex / claude / gemini。 */
  provider: Provider;
  /** 页面上展示给用户看的名字，例如“范德彪”“黄仁勋”“桂芬”。 */
  alias: string;
  /** 消息角色。user 表示用户发出的，assistant 表示 agent 发出的。 */
  role: "user" | "assistant";
  /** 真正显示在聊天气泡里的文本内容。 */
  content: string;
  /** 心里话内容，推理过程。 */
  thinking?: string;
  /** 输入 token 数。 */
  inputTokens?: number;
  /** 输出 token 数。 */
  outputTokens?: number;
  /** 缓存百分比。 */
  cachedPercent?: number;
  /** 这条消息产生时，该 thread 当前使用的模型名。 */
  model: string | null;
  /** ISO 时间字符串，用来排序时间线。 */
  createdAt: string;
};

/**
 * Invocation 事件统计。
 */
export interface InvocationStats {
  sessionId: string;
  agentId: string;
  provider: Provider;
  model: string;
  startedAt: string;
  status: "ACTIVE" | "IDLE" | "ERROR";
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * 左侧历史会话列表里的一条摘要。
 * 它不是完整会话，只是用来做列表展示。
 */
export type SessionGroupSummary = {
  /** 会话组 ID。一个会话组代表一次完整的多 agent 会话。 */
  id: string;
  /** 左侧列表显示的标题。 */
  title: string;
  /** 已经格式化好的更新时间字符串，直接给前端显示。 */
  updatedAtLabel: string;
  /** 三个 provider 各自的最后一条摘要预览。 */
  previews: Array<{
    /** 这条摘要属于哪个 provider。 */
    provider: Provider;
    /** 该 provider 当前展示别名。 */
    alias: string;
    /** 左侧列表里显示的短文本预览。 */
    text: string;
  }>;
};

/**
 * 单个 provider 的模型信息。
 * 前端顶部卡片和模型选择器都会用到它。
 */
export type ProviderCatalog = {
  /** provider 标识。 */
  provider: Provider;
  /** provider 当前别名。 */
  alias: string;
  /** 当前默认或当前 thread 正在使用的模型。 */
  currentModel: string | null;
  /** 模型候选列表，用来做前端可搜索下拉。 */
  modelSuggestions: string[];
};

/**
 * 前端 -> 后端 的实时事件。
 * 这些事件通过 WebSocket 发给 Fastify。
 */
export type RealtimeClientEvent =
  | {
      /** 发送一条聊天消息。 */
      type: "send_message";
      payload: {
        /** 这条消息要进入哪个 thread。 */
        threadId: string;
        /** 这条消息指向哪个 provider。 */
        provider: Provider;
        /** 真正发送给 agent 的正文，不包含前端输入时的 @前缀。 */
        content: string;
        /** 这次发送时前端展示给用户的别名。 */
        alias: string;
      };
    }
  | {
      /** 停止某个 thread 当前正在运行的 agent。 */
      type: "stop_thread";
      payload: {
        /** 要停止的 thread ID。 */
        threadId: string;
      };
    };

/**
 * 后端 -> 前端 的实时事件。
 * 这些事件由 Fastify 通过 WebSocket 主动推送给浏览器。
 */
export type RealtimeServerEvent =
  | {
      /** 某条 assistant 消息新增了一段增量文本。 */
      type: "assistant_delta";
      payload: {
        /** 要把这段 delta 追加到哪条消息上。 */
        messageId: string;
        /** 本次新增的文本片段。 */
        delta: string;
      };
    }
  | {
      /** 新创建了一条完整消息。常见于用户消息、assistant 占位消息、callback 公共消息。 */
      type: "message.created";
      payload: {
        /** 这条消息属于哪个 thread。 */
        threadId: string;
        /** 可直接渲染到前端时间线的完整消息对象。 */
        message: TimelineMessage;
      };
    }
  | {
      /** 当前激活会话组的完整快照。前端收到后可以直接整体替换当前页面状态。 */
      type: "thread_snapshot";
      payload: {
        activeGroup: {
          /** 当前会话组 ID。 */
          id: string;
          /** 当前会话组标题。 */
          title: string;
          /** 当前会话组附加说明，例如更新时间。 */
          meta: string;
          /** 当前会话组的统一时间线。 */
          timeline: TimelineMessage[];
          /** 三个 provider 的卡片状态。key 是 provider，value 是卡片需要的展示数据。 */
          providers: Record<
            Provider,
            {
              /** 这个 provider 在当前会话组里的 thread ID。 */
              threadId: string;
              /** 展示给用户看的别名。 */
              alias: string;
              /** 当前 thread 使用的模型。 */
              currentModel: string | null;
              /** 额度摘要文本。 */
              quotaSummary: string;
              /** 最近一条摘要。 */
              preview: string;
              /** 当前这个 thread 是否正在运行。 */
              running: boolean;
            }
          >;
        };
      };
    }
  | {
      /** 页面顶部或输入区展示的一条短状态文本。 */
      type: "status";
      payload: {
        /** 例如“正在运行黄仁勋”“实时层已连接”这种状态消息。 */
        message: string;
      };
    };
