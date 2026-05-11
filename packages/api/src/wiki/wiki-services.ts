/**
 * F027 P3.e · Wiki services factory —— P0/P1/P10/P21/P2/P3 各 module 的 wire 入口。
 * 真相源：docs/plans/V16.5-final.md chap 5 / 6
 *
 * 职责：
 *   - 以 drizzle DB + wikiRoot + ACL yaml 为输入，构造可用的 service 实例
 *   - server.ts 拿这个 factory 输出注入 callback routes
 *   - 不做 IO 副作用（不创建目录、不写文件）；caller 自决
 *
 * Phase 1 P3 实施期：
 *   - leaderTerm hardcoded 'term-1'（P3.5 接 compiler_leader.current_term DB 查询）
 *   - ACL 配置内嵌默认（P3.6 Handbook 切片再外置 wiki.config.yaml）
 *   - onCommit 接受外部 hook（compiler debounce 由 caller 控制）
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { WikiEventsRepository } from "../db/repositories/wiki-events-repository"
import { WikiLeasesRepository } from "../db/repositories/wiki-leases-repository"
import type * as schema from "../db/schema"
import { compileACL, loadACLConfig } from "./acl-engine"
import type { CompiledACL } from "./acl-engine"
import { UpdateWikiService } from "./update-wiki-service"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/**
 * P3.6 Handbook 切片之前的内嵌 ACL —— 与 V16.5 chap 6 sample 对齐 + 当前
 * Phase 1 实际写入路径（wiki/concepts/** + wiki/work/** + wiki/people/** + room）。
 * 真正配置文件留 P3.6。
 */
export const DEFAULT_ACL_YAML = `
acl:
  - path_pattern: 'wiki/rules/**'
    allowed_aliases: ['小孙']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/people/<self>.md'
    allowed_aliases: ['<self>']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/people/<other>.md'
    allowed_aliases: ['小孙']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/people/小孙.md'
    allowed_aliases: ['小孙', 'system-auto-feedback-detector']
    allowed_actions: [write, patch, append]

  - path_pattern: 'wiki/concepts/draft/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, patch, demote]

  - path_pattern: 'wiki/concepts/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/work/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, append, patch]

  - path_pattern: 'wiki/feedback/draft/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write]

  - path_pattern: 'wiki/feedback/**'
    allowed_aliases: ['小孙']
    allowed_actions: [write, patch, promote]

  - path_pattern: 'wiki/rooms/<roomId>/decisions.md'
    allowed_aliases: ['system-auto-room-compiler']
    allowed_actions: [append]

  - path_pattern: 'wiki/rooms/<roomId>/agent-sessions/<alias>/S-*.md'
    allowed_aliases: ['system-auto-room-compiler']
    allowed_actions: [write, append]

  - path_pattern: 'wiki/raw/user-drops/**'
    allowed_aliases: ['小孙']
    allowed_actions: [write]

  - path_pattern: 'wiki/raw/conversations/**'
    allowed_aliases: ['system-auto-transcript-writer']
    allowed_actions: [write]

  - path_pattern: 'wiki/raw/work-products/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/raw/external/**'
    allowed_aliases: ['小孙', '<any-agent>']
    allowed_actions: [write]

  - path_pattern: 'wiki/index.md'
    allowed_aliases: []

  - path_pattern: 'wiki/index/**'
    allowed_aliases: []

  - path_pattern: 'wiki/sources.md'
    allowed_aliases: []

  - path_pattern: 'wiki/log.md'
    allowed_aliases: []
`

export interface WikiServices {
  events: WikiEventsRepository
  leases: WikiLeasesRepository
  acl: CompiledACL
  updateWiki: UpdateWikiService
  wikiRoot: string
}

export interface WikiServicesConfig {
  db: DrizzleDb
  wikiRoot: string
  /** P3.5 之前 hardcoded；P3.5 后接 compiler_leader.current_term 查询。 */
  leaderTerm?: () => string
  /** Compiler debounce hook：service commit 后回调。 */
  onCommit?: (eventId: number, path: string) => void
  /** 自定义 ACL yaml 配置（默认 DEFAULT_ACL_YAML）。 */
  aclYaml?: string
}

export function createWikiServices(cfg: WikiServicesConfig): WikiServices {
  const events = new WikiEventsRepository(cfg.db)
  const leases = new WikiLeasesRepository(cfg.db)
  const acl = compileACL(loadACLConfig(cfg.aclYaml ?? DEFAULT_ACL_YAML))
  const updateWiki = new UpdateWikiService({
    events,
    leases,
    acl,
    wikiRoot: cfg.wikiRoot,
    leaderTerm: cfg.leaderTerm ?? (() => "term-1"),
    onCommit: cfg.onCommit,
  })
  return { events, leases, acl, updateWiki, wikiRoot: cfg.wikiRoot }
}
