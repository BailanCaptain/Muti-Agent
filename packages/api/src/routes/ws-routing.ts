/**
 * F026 P0 Day2 · I3 Broadcaster 后端强隔离。
 *
 * extractSessionGroupId 本体 F031 起上移 shared（realtime-routing.ts）——客户端
 * StreamMonitor 的 seq 校验必须与服务端 broadcast 过滤/注 seq 用同一套提取规则
 * （德彪 r4 P2：dispatch.blocked 两端规则不同源 → 假 gap）。此处 re-export 保持
 * api 侧既有 import 路径不变。
 */
export { extractSessionGroupId } from "@multi-agent/shared"

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
