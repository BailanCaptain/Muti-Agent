"use client";

import {
  extractSessionGroupId,
  type SequencedRealtimeServerEvent,
  type WsWatermark,
} from "@multi-agent/shared";
import type { DeltaHoleInfo } from "../stores/thread-store";

/**
 * F031 AC3/AC6 · WS 广播流 gap 检测（客户端）。
 *
 * 基线来自快照水位线（GET /api/session-groups/:groupId 的 wsWatermark，
 * selectSessionGroup 换基线）。只跟踪当前订阅组：
 *   - seq ≤ 基线 → drop（快照已覆盖，防重放误报）
 *   - seq 连续 → apply；跳号 → gap：warn 丢失区间 + 触发 catch-up（事件本身 apply，
 *     基线推进到跳号位——中间丢的由 catch-up 全量重拉补）
 *   - epoch 变化 → 服务端重启：重置基线 + 全量重拉
 *   - 无 seq 事件（直发通道/legacy fan-out）不参与校验
 *
 * catch-up 动作由 page.tsx 注入（复用 selectSessionGroup 全量重拉，与 onReconnect
 * 同路径）；本模块不 import store，避免依赖环。护栏：进行中 debounce 不叠加，
 * 连续失败 MAX_CATCHUP_FAILURES 次后降级（等下次重连/切房间换基线复位）。
 */

const MAX_CATCHUP_FAILURES = 3

export type StreamMonitorVerdict = "apply" | "drop"
export type CatchUpReason = "gap" | "epoch-changed" | "delta-hole"

// 提取规则与服务端注 seq / 订阅过滤同源（shared/realtime-routing.ts，德彪 r4 P2：
// dispatch.blocked 的 groupId 在 attempts[0]，两端规则漂移 = lastSeq 不推进 = 假 gap）

export class StreamMonitor {
  private groupId: string | null = null
  private lastEpoch: string | null = null
  private lastSeq = 0
  private catchUpInFlight = false
  private failCount = 0
  private degradedWarned = false
  private catchUp: ((reason: CatchUpReason) => void) | null = null
  // F031 德彪 r4 P1 · 切房间 pending 窗口记账：subscribe 已生效但快照未落地时，
  // 新组事件会被 page 的 isCurrentSession 丢弃（activeGroupId 未切）。若其中有
  // seq > 落地水位线的事件（组装完成后才广播的），快照不含它且无后续 gap 可触发
  // —— 终版事件就永久丢了。记 pendingMaxSeq，setBaseline 时对账补拉。
  private pendingGroupId: string | null = null
  private pendingMaxSeq = 0

  /** page.tsx 注册 catch-up 动作（selectSessionGroup 全量重拉） */
  onCatchUp(fn: ((reason: CatchUpReason) => void) | null) {
    this.catchUp = fn
  }

  /** 切房间开始（selectSessionGroup 入口、subscribe 之前）调用，开启 pending 记账 */
  beginSwitch(groupId: string) {
    if (groupId === this.groupId) {
      // 同组重选（catch-up 重拉 / 重连恢复）：无切换窗口，观测照常
      this.pendingGroupId = null
      this.pendingMaxSeq = 0
      return
    }
    this.pendingGroupId = groupId
    this.pendingMaxSeq = 0
  }

  /** 快照落地换基线（selectSessionGroup / bootstrap 后调用）。同时复位护栏计数。 */
  setBaseline(groupId: string, watermark: WsWatermark) {
    const pendingMissed =
      this.pendingGroupId === groupId && this.pendingMaxSeq > watermark.seq
        ? this.pendingMaxSeq
        : null
    this.groupId = groupId
    this.lastEpoch = watermark.epoch
    // pending 窗口见过更高 seq：基线推进到已见位（防后续事件重复报 gap），差额走补拉
    this.lastSeq = pendingMissed ?? watermark.seq
    this.pendingGroupId = null
    this.pendingMaxSeq = 0
    this.catchUpInFlight = false
    this.failCount = 0
    this.degradedWarned = false
    if (pendingMissed !== null) {
      this.warn({
        groupId,
        pendingMaxSeq: pendingMissed,
        watermarkSeq: watermark.seq,
        action: "catch-up",
      })
      this.requestCatchUp("gap")
    }
  }

  /** catch-up 结束回报（成功=复位失败计数；失败=累计，达上限降级） */
  catchUpDone(ok: boolean) {
    this.catchUpInFlight = false
    if (ok) {
      this.failCount = 0
    } else {
      this.failCount += 1
    }
  }

  /**
   * 观测一条服务端事件。返回 "drop" 时调用方跳过该事件（快照已覆盖的陈旧重放）。
   */
  observe(event: SequencedRealtimeServerEvent): StreamMonitorVerdict {
    if (event.seq === undefined || event.epoch === undefined) return "apply"
    const groupId = extractSessionGroupId(event)
    if (!groupId) return "apply"

    if (this.groupId === null || this.groupId !== groupId) {
      if (groupId === this.pendingGroupId) {
        // 切房间窗口（含首次加载 groupId===null 的初选路径，德彪 r5 P1：pending
        // 判定必须先于静默采纳，否则窗口事件被建成基线、setBaseline 又盖掉 → 沉默丢）：
        // 内容会被 page 丢弃，这里只记账最高 seq，setBaseline 时对账
        this.pendingMaxSeq = Math.max(this.pendingMaxSeq, event.seq)
      } else if (this.groupId === null) {
        // 无基线且非 pending 组（bootstrap 前后首次接触）：静默采纳为基线，不误报
        this.groupId = groupId
        this.lastEpoch = event.epoch
        this.lastSeq = event.seq
      }
      return "apply"
    }

    if (event.epoch !== this.lastEpoch) {
      this.warn({ groupId, epoch: event.epoch, priorEpoch: this.lastEpoch, action: "full-resync" })
      this.lastEpoch = event.epoch
      this.lastSeq = event.seq
      this.requestCatchUp("epoch-changed")
      return "apply"
    }

    if (event.seq <= this.lastSeq) return "drop"

    if (event.seq === this.lastSeq + 1) {
      this.lastSeq = event.seq
      return "apply"
    }

    // 跳号 gap：[lastSeq+1, seq-1] 丢失。事件本身是新的照常 apply，基线推进，
    // 丢失区间交给 catch-up 全量重拉。
    this.warn({
      groupId,
      epoch: event.epoch,
      missedFrom: this.lastSeq + 1,
      missedTo: event.seq - 1,
      action: "catch-up",
    })
    this.lastSeq = event.seq
    this.requestCatchUp("gap")
    return "apply"
  }

  /** thread-store deltaHoleHandler 接线：消息内空洞与 seq gap 共用 catch-up 通道 */
  reportHole(info: DeltaHoleInfo) {
    this.warn({ groupId: this.groupId, hole: info, action: "catch-up" })
    this.requestCatchUp("delta-hole")
  }

  private requestCatchUp(reason: CatchUpReason) {
    if (this.catchUpInFlight) return
    if (this.failCount >= MAX_CATCHUP_FAILURES) {
      if (!this.degradedWarned) {
        this.degradedWarned = true
        this.warn({
          groupId: this.groupId,
          degraded: true,
          failCount: this.failCount,
          action: "await-reconnect-or-room-switch",
        })
      }
      return
    }
    this.catchUpInFlight = true
    this.catchUp?.(reason)
  }

  private warn(fields: Record<string, unknown>) {
    // AC6 · 结构化一行日志：让「消息没显示」从玄学变成可 grep 的证据
    console.warn("[F031:ws-gap]", fields)
  }
}

export const streamMonitor = new StreamMonitor()
