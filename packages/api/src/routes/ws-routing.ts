import type { RealtimeServerEvent } from "@multi-agent/shared"

/**
 * F026 P0 Day2 · I3 Broadcaster 后端强隔离。
 *
 * 返回 event 所属 sessionGroupId：
 *   - 绝大多数 server event payload 带 sessionGroupId（assistant_delta / thread_snapshot /
 *     approval.resolved / decision.* 等）
 *   - `approval.request` / `decision.request`：payload 本身是 request 对象，内部带 sessionGroupId
 *   - `dispatch.blocked`：payload.attempts 是数组，同一批拦截必定同一会话；取 attempts[0]
 *   - `message.created`：payload.sessionGroupId 可选——这类"无会话绑定"事件按 null 处理
 *     (见 shouldDeliver 的 legacy fan-out 策略)
 *   - `status` / `preview.auto_open`：payload.sessionGroupId 可选，同上
 *
 * 返回 null = "此事件无 group 绑定"，broadcaster 对未订阅或任意 group 均 fan-out（legacy 兼容）。
 */
export function extractSessionGroupId(event: RealtimeServerEvent): string | null {
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload) return null

  const direct = payload.sessionGroupId
  if (typeof direct === "string" && direct.length > 0) return direct

  if (event.type === "dispatch.blocked") {
    const attempts = (payload as { attempts?: Array<{ sessionGroupId?: string }> }).attempts
    const first = attempts?.[0]?.sessionGroupId
    return typeof first === "string" && first.length > 0 ? first : null
  }

  return null
}

/**
 * 严格隔离策略（P0 Design Decision）：
 *   - event 带 groupId：仅发给 subscribed 到相同 group 的 socket
 *   - event 不带 groupId：fan-out 给所有 socket（legacy · plan Day 2 决策 A）
 *
 * 订阅状态 (socketGroupId) 语义：
 *   - undefined = socket 尚未订阅（刚连接、还没切房间）
 *     → room-scoped 事件一律不送（避免首屏未订阅就看到别人房间 delta）
 *   - string = 已订阅某个 group
 *
 * 对于 legacy 兼容考虑：`dispatch.blocked` / `approval.request` 等目前有 sessionGroupId
 * 的都按严格路径走；只有真的没有 groupId 的事件（当前限于部分 `status` / `preview.auto_open`）
 * 退化到 fan-out。
 */
export function shouldDeliver(
  socketGroupId: string | undefined,
  eventGroupId: string | null,
): boolean {
  if (eventGroupId === null) return true
  if (socketGroupId === undefined) return false
  return socketGroupId === eventGroupId
}
