import { randomUUID } from "node:crypto"

/**
 * F031 · per-sessionGroup 单调序列号 + 进程 epoch。
 *
 * 单实例 in-memory（clowder KD-9：明确拒绝分布式 sequencer）。重启后 seq 归零，
 * 靠 epoch 变化让客户端把"归零"识别为重启（→ 重置基线 + 全量重拉），而不是误判
 * 陈旧事件或跳号 gap。
 *
 * 注入点约定（Design Gate r1-r3，德彪 GO）：**只在 ws.ts broadcast 咽喉消耗计数器**。
 * 直发通道（send_message 的 socket-bound per-turn emit）不注 seq——直发只达单 socket，
 * 消耗同组计数器会给其他订阅 socket 制造假 gap → catch-up 风暴。
 */
export class GroupSequencer {
  readonly epoch = randomUUID()
  private seqs = new Map<string, number>()

  /** 消耗下一个序号（首次 = 1）。仅 broadcast 咽喉调用。 */
  next(groupId: string): number {
    const n = (this.seqs.get(groupId) ?? 0) + 1
    this.seqs.set(groupId, n)
    return n
  }

  /** 只读当前水位（从未广播过 = 0）。快照端点 read-before-build 用。 */
  current(groupId: string): number {
    return this.seqs.get(groupId) ?? 0
  }
}
