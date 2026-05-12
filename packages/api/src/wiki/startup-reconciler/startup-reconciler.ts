/**
 * F027 P7.5 · Startup Reconciler · runtime 启动钩子
 * 真相源：docs/plans/V16.5-final.md chap 5 行 506-517 + chap 8 行 918-925 + chap 21 行 2323
 *
 * 角色：runtime 启动时一次性跑，恢复 crash 后未 settle 的 wiki_events + room_checkpoints。
 * 顺序：先 wiki_events（基础设施层）→ 再 room_checkpoints（应用层依赖 wiki 状态）。
 *
 * AC（kill -9 后重启状态恢复）：
 *   1. 模拟 PREPARE 后崩 → wiki_events 'pending' + 文件 base 不变 → reconciler 走 aborted_clean
 *   2. WRITE 后崩 → file_hash == attempted → reconciler 走 committed
 *   3. RoomCompiler write 完 commit 失败 → recoverIncomplete 补 committed_at
 *   4. 第三方污染 → aborted_dirty + logger 告警，不自动恢复
 *
 * 失败语义：
 *   - 单条 wiki_events 处理失败（fs 错误等）→ 抛 StartupReconcilerError("wiki_events", ...)
 *     caller 决定 fail-closed（不启动）还是 retry
 *   - room_checkpoints recover 失败同理
 */

import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { RoomCompiler } from "../room-compiler/room-compiler"
import { type StartupReconcileReport, StartupReconcilerError } from "./types"
import { reconcileWikiEvents } from "./wiki-event-reconciler"

export interface StartupReconcilerOptions {
  wikiEvents: WikiEventsRepository
  roomCompiler: RoomCompiler
  /** event.path 解析根 + RoomCompiler.wikiRoot 同源（caller 保证传一致路径）。 */
  wikiRoot: string
  logger?: (msg: string) => void
}

export class StartupReconciler {
  constructor(private readonly opts: StartupReconcilerOptions) {}

  /**
   * 跑一次启动恢复。返回 report 含两个域 + alert 计数。
   * caller（runtime 启动入口）拿 report 决定：
   *   - alerts.abortedDirtyCount > 0 → 写 evidence pack + 通知小孙
   *   - 其它走 silent recovery
   */
  async run(now?: number): Promise<StartupReconcileReport> {
    const startedAt = new Date(now ?? Date.now()).toISOString()

    let wikiEventsSummary: StartupReconcileReport["wikiEvents"]
    try {
      wikiEventsSummary = await reconcileWikiEvents({
        repo: this.opts.wikiEvents,
        wikiRoot: this.opts.wikiRoot,
        logger: this.opts.logger,
      })
    } catch (err) {
      throw new StartupReconcilerError(
        "wiki_events",
        `reconcileWikiEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    let roomCheckpointsReport: StartupReconcileReport["roomCheckpoints"]
    try {
      roomCheckpointsReport = await this.opts.roomCompiler.recoverIncomplete(now)
    } catch (err) {
      throw new StartupReconcilerError(
        "room_checkpoints",
        `roomCompiler.recoverIncomplete failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    const finishedAt = new Date(Date.now()).toISOString()

    const report: StartupReconcileReport = {
      startedAt,
      finishedAt,
      wikiEvents: wikiEventsSummary,
      roomCheckpoints: roomCheckpointsReport,
      alerts: {
        abortedDirtyCount: wikiEventsSummary.abortedDirty,
      },
    }

    this.opts.logger?.(
      `[startup-reconciler] done in ${
        Date.parse(finishedAt) - Date.parse(startedAt)
      }ms · wiki_events scanned=${wikiEventsSummary.scanned} ` +
        `committed=${wikiEventsSummary.committed} aborted=${wikiEventsSummary.abortedClean} ` +
        `dirty=${wikiEventsSummary.abortedDirty} · room_checkpoints scanned=${roomCheckpointsReport.scanned} ` +
        `patched=${roomCheckpointsReport.patched} rolledBack=${roomCheckpointsReport.rolledBack}`,
    )

    return report
  }
}

export { reconcileWikiEvents, decideVerdict } from "./wiki-event-reconciler"
export type {
  StartupReconcileReport,
  WikiEventReconcileVerdict,
  WikiEventReconcileSummary,
  WikiEventReconcileDetail,
} from "./types"
