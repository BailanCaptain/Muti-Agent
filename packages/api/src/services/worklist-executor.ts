import type { CallRegistry } from "../orchestrator/call-registry"
import type { QueueEntry } from "../orchestrator/dispatch"
import type { WorklistItem, WorklistItemStatus } from "../orchestrator/worklist-advance"
import type { WorklistRegistry, WorklistRow } from "../orchestrator/worklist-registry"

/**
 * F026 P2 v2 · WorklistExecutor — message-service 与 worklist-registry 间的桥梁。
 *
 * 责任：
 *   - registerForDispatch(parentCallId, queued) → 在 worklist 树上注册新 worklist；
 *     反查派发者所在的 grandparent worklist 决定 parentWorklistId（树形 v2 关键）
 *   - onChildFinished(childCallId, childContent, ok) → 标 item done/failed → cascade settle
 *   - 触发 onDoneContinuation 回调（仅在 root worklist settle 时；中间层 settle 静默）
 *
 * 不在本类的责任：
 *   - 续推 prompt 合成（worklist-continuation.ts 纯函数）
 *   - 实际派发新 invocation（message-service.dispatchWorklistContinuation 走原派发链）
 */

export interface WorklistExecutorOptions {
  callRegistry: CallRegistry
  worklistRegistry: WorklistRegistry
}

export interface RegisterForDispatchInput {
  /** 派发者 agent 的 call_id（user-root 时也是 callId 自己）。 */
  parentCallId: string | null | undefined
  sessionGroupId: string
  queued: ReadonlyArray<QueueEntry>
}

export interface OnChildFinishedInput {
  childCallId: string | null | undefined
  childAlias?: string | null | undefined
  childContent: string
  ok: boolean
  /** 透传给 onDoneContinuation 的不透明上下文（emit / rootMessageId 等） */
  continuationContext?: unknown
}

export type OnChildFinishedDecision = "halted" | "advanced" | "settled" | "noop"

export interface OnChildFinishedResult {
  decision: OnChildFinishedDecision
  rootSettled: boolean
}

export interface OnDoneContinuationArgs {
  worklist: WorklistRow
  childAliases: string[]
  parentCallId: string
  continuationContext: unknown
}

export type OnDoneContinuationCallback = (args: OnDoneContinuationArgs) => void

export class WorklistExecutor {
  private readonly callRegistry: CallRegistry
  private readonly worklistRegistry: WorklistRegistry
  private onDoneContinuation: OnDoneContinuationCallback | null = null

  constructor(options: WorklistExecutorOptions) {
    this.callRegistry = options.callRegistry
    this.worklistRegistry = options.worklistRegistry
  }

  /** 注入"root settle 时派续推"的回调。message-service 在构造时 wire。 */
  setOnDoneContinuation(cb: OnDoneContinuationCallback | null): void {
    this.onDoneContinuation = cb
  }

  /**
   * 在派发新 mention 后调用：在 worklist 树上注册一条新 worklist 记录。
   *
   * parentWorklistId 反查规则（v2 树形核心）：
   *   1. 拿派发者 callRow（parentCallId 对应的 a2a_calls 行）
   *   2. callRow.parentCallId = grandparent_call_id（派发者本身的父 call）
   *   3. findActiveByParentCallId(grandparent_call_id) → 派发者本身正处于的 worklist
   *      - 找到 → 它就是新 worklist 的 parent（child worklist 挂上去）
   *      - 找不到（dispatcher 在 user-root 层，或 grandparent worklist 已 settled）→ 新 worklist 是 root
   *
   * 返回新 worklistId，或 null（缺前置条件：parentCallId 缺失 / queued 空 / call 找不到）
   */
  registerForDispatch(input: RegisterForDispatchInput): string | null {
    if (!input.parentCallId) return null
    if (input.queued.length === 0) return null

    const callRow = this.callRegistry.get(input.parentCallId)
    if (!callRow) return null

    const rootCallId = callRow.rootCallId

    let parentWorklistId: string | null = null
    if (callRow.parentCallId) {
      const grandparentWorklist: WorklistRow | null =
        this.worklistRegistry.findActiveByParentCallId(callRow.parentCallId)
      parentWorklistId = grandparentWorklist?.worklistId ?? null
    }

    const items: WorklistItem[] = input.queued.map((entry) => ({
      alias: entry.to.agentId,
      status: "pending",
    }))

    return this.worklistRegistry.register({
      parentWorklistId,
      parentCallId: input.parentCallId,
      rootCallId,
      sessionGroupId: input.sessionGroupId,
      items,
    })
  }

  /**
   * 子 invocation 完成后调用：标 item done/failed → cascade settle → root settle 时派续推。
   *
   * 决策语义：
   *   - "noop": 找不到 worklist / 缺前置条件
   *   - "halted": child failed 或 empty content → 直接 settle worklist（不 cascade，不续推）
   *   - "advanced": item 标 done 但 cascade 0 步（worklist 仍 active 等其他 children）
   *   - "settled": cascade 走完至少一步（链路收敛了一截，rootSettled=true 表示根也 settled）
   *
   * 续推回调（onDoneContinuation）只在 root worklist (parentWorklistId IS NULL) settle 时调用。
   * 中间层 worklist settle 时不调——它的 parent agent 自己 finished 时由 cascade 自然推进。
   */
  onChildFinished(input: OnChildFinishedInput): OnChildFinishedResult | null {
    if (!input.childCallId) return null

    const childRow = this.callRegistry.get(input.childCallId)
    if (!childRow) return null
    const parentCallId = childRow.parentCallId
    if (!parentCallId) return null

    const worklist = this.worklistRegistry.findActiveByParentCallId(parentCallId)
    if (!worklist) return null

    // 反查 alias 对应 idx：
    //   - 显式 alias 不在 items → noop（review#1 directTurn race fix）
    //     兄弟 child（如 thread agent 自己 directTurn）也挂在同 parentCallId 下，
    //     调进来时 alias ≠ 任何 item alias，不能 fallback currentIndex 污染兄弟 item
    //   - alias 缺省（undefined）→ 老路径 fallback currentIndex（兼容单 item worklist）
    let completedIndex: number
    if (input.childAlias) {
      const found = worklist.items.findIndex((it) => it.alias === input.childAlias)
      if (found < 0) return null
      completedIndex = found
    } else {
      completedIndex = worklist.currentIndex
    }

    const itemStatus: WorklistItemStatus =
      !input.ok || (input.childContent ?? "").trim().length === 0 ? "failed" : "done"
    this.worklistRegistry.markItemStatus(worklist.worklistId, completedIndex, itemStatus)

    // failed 路径：halt 语义 — 直接 settle 自身，不 cascade，不续推
    if (itemStatus === "failed") {
      this.worklistRegistry.settle(worklist.worklistId)
      return { decision: "halted", rootSettled: false }
    }

    // cascade 路径（v2 核心）
    const cascade = this.worklistRegistry.tryCascadeSettle(worklist.worklistId)
    if (cascade.settled.length === 0) {
      return { decision: "advanced", rootSettled: false }
    }

    // 只在 root worklist (parentWorklistId IS NULL) settle 时触发续推
    let rootSettled = false
    for (const settledId of cascade.settled) {
      const settled = this.worklistRegistry.get(settledId)
      if (!settled) continue
      if (settled.parentWorklistId !== null) continue // 中间层 settle 不派续推
      rootSettled = true

      // F026 P3 continuation guard：root tree 内任何 child worklist.items 含 panel
      // agent alias → panel agent 已在某 leaf 被自然召唤回 reply 过（接力链终点 /
      // 反向接力收口），续推就重复（R-095 / R-096 两条仁勋第二条）。跳过派发。
      if (this.shouldSkipContinuation(settled)) continue

      if (this.onDoneContinuation) {
        const childAliases = settled.items
          .map((it) => it.alias)
          .filter((a): a is string => typeof a === "string" && a.length > 0)
        try {
          this.onDoneContinuation({
            worklist: settled,
            childAliases,
            parentCallId: settled.parentCallId,
            continuationContext: input.continuationContext,
          })
        } catch {
          // 续推回调抛错不应阻断 cascade；上游 logger 自己处理
        }
      }
    }

    return { decision: "settled", rootSettled }
  }

  /**
   * F026 P3 · root settle 前判断：root tree 内（root worklist 自身除外）任何
   * worklist.items 是否含 panel agent alias。是则 panel agent 已在某 leaf 自然
   * 召回 reply 过 —— 续推派发会重复（R-095/R-096 案）。
   *
   * panel agent alias 取自 root worklist 的 parentCall.replyTo（"claude:黄仁勋" →
   * "黄仁勋"）。non-provider:alias 格式（如 "user"）直接放行（旧路径，guard 不动）。
   */
  private shouldSkipContinuation(rootWorklist: WorklistRow): boolean {
    const parentCall = this.callRegistry.get(rootWorklist.parentCallId)
    if (!parentCall) return false
    const replyTo = parentCall.replyTo
    const colonIdx = replyTo.indexOf(":")
    if (colonIdx < 0) return false
    const panelAlias = replyTo.slice(colonIdx + 1)
    if (!panelAlias) return false

    const allWorklists = this.worklistRegistry.findAllByRootCallId(rootWorklist.rootCallId)
    return allWorklists.some(
      (wl) =>
        wl.worklistId !== rootWorklist.worklistId &&
        wl.items.some((it) => it.alias === panelAlias),
    )
  }
}
