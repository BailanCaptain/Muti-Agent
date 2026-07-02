import type { RealtimeServerEvent } from "./realtime"

/**
 * 返回 event 所属 sessionGroupId（无 group 绑定 = null）。
 *
 * F026 P0 Day2 起服务端 broadcaster 用它做订阅强过滤；F031 起客户端 StreamMonitor
 * 用同一函数判定事件是否参与 seq 校验——**两端必须同源**（德彪 F031 r4 P2：服务端
 * 对 dispatch.blocked 按 attempts[0] 消耗 seq，客户端若只看 payload.sessionGroupId
 * 就不推进基线 → 下一条正常事件被误判跳号 → 假 catch-up）。改提取规则只改这里。
 *
 * 规则：
 *   - 绝大多数 server event payload 带 sessionGroupId（assistant_delta / thread_snapshot /
 *     approval.resolved / decision.* 等；approval.request / decision.request 的 payload
 *     本身是 request 对象，内部带 sessionGroupId，同样走 direct 路径）
 *   - `dispatch.blocked`：payload.attempts 是数组，同一批拦截必定同一会话；取 attempts[0]
 *   - `message.created` / `status` / `preview.auto_open`：payload.sessionGroupId 可选，
 *     缺省按 null（legacy fan-out）
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
