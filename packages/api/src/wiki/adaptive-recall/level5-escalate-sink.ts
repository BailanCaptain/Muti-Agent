/**
 * F027 P13.4 · Level 5 escalate sinks
 *
 * P13 模块边界（设计选择）：escalate 不绑定具体 audit 后端。
 *   - NoopLevel5Sink: 测试 / 极简集成用，just resolves
 *   - ConsoleWarnLevel5Sink: 开发环境，console.warn 打信息
 *   - 真生产 caller (orchestrator / RoomCompiler) 应实现自己的 Sink
 *     写 wiki_events / prompt_audit / 推审计通知到 room，并注入 P13 executor
 *
 * 默认推荐：
 *   - 开发 / 测试 → NoopLevel5Sink
 *   - dev preview → ConsoleWarnLevel5Sink（看到 escalate 信号）
 *   - 生产 → caller 自己实现（access 自己的 db lease/fencing context）
 */

import type { EscalateInfo, Level5Sink } from "./types"

export class NoopLevel5Sink implements Level5Sink {
  async escalate(_info: EscalateInfo): Promise<void> {
    // intentional no-op
  }
}

export class ConsoleWarnLevel5Sink implements Level5Sink {
  constructor(
    private readonly log: (msg: string, info: EscalateInfo) => void = defaultConsoleWarn,
  ) {}

  async escalate(info: EscalateInfo): Promise<void> {
    this.log(
      `[F027-P13] recall escalated to user — room=${info.roomId} alias=${info.alias} ` +
        `trigger=${info.trigger} visited=[${info.visitedLevels.join(",")}] reason=${info.reason}`,
      info,
    )
  }
}

function defaultConsoleWarn(msg: string, _info: EscalateInfo): void {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/**
 * 测试 sink：记录所有 escalate 调用，用于 assertion。
 */
export class RecordingLevel5Sink implements Level5Sink {
  public readonly calls: EscalateInfo[] = []

  async escalate(info: EscalateInfo): Promise<void> {
    this.calls.push(info)
  }
}
