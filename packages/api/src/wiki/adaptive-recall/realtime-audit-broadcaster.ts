/**
 * F027 Phase 4 AC-P4-8 (e2) (codex Week 5 j2 FAIL Red→Green) ·
 * RealtimeAuditBroadcaster — 把 ProductionLevel5Sink 的 AuditBroadcaster 接到
 * 现有 RealtimeBroadcaster (WS pub/sub)。
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-8 (e2):
 *     "NotificationBroadcast — 推审计通知到 R-001 房间"
 *   - codex Week 5 j2 FAIL: server.ts:293 ProductionLevel5Sink 构造时 broadcaster 缺
 *     (level5-escalate-sink.ts:170 仅 if (this.broadcaster) broadcast)
 *   - shared/realtime.ts RealtimeServerEvent 已加 'recall.escalated' 类型
 *
 * 设计:
 *   - 输入 RealtimeBroadcaster (server.ts:124 创建, 内部走 WS pub/sub)
 *   - 适配 AuditBroadcaster 接口 (level5-escalate-sink.ts:78 定义)
 *   - 转发: AuditBroadcaster.broadcast → RealtimeBroadcaster.broadcast
 *     (event type='recall.escalated', payload 透传)
 *
 * 接口 alignment:
 *   - AuditBroadcaster.broadcast(event: { type: 'recall.escalated', payload }) → void
 *   - RealtimeBroadcaster.broadcast(event: RealtimeServerEvent) → void
 *   - 'recall.escalated' 已在 RealtimeServerEvent union (shared/realtime.ts)
 *
 * Fail-soft (跟 ProductionLevel5Sink 一致):
 *   - 不抛错, 让 Level5 sink 内部 try/catch 处理 (sink line 204 logger.warn fail-soft)
 */

import type { RealtimeBroadcaster } from "../../routes/ws"
import type { AuditBroadcaster } from "./level5-escalate-sink"

export function createRealtimeAuditBroadcaster(
  realtime: RealtimeBroadcaster,
): AuditBroadcaster {
  return {
    broadcast: (event) => {
      // event.type === 'recall.escalated', payload 已对齐 shared union
      realtime.broadcast(event)
    },
  }
}
