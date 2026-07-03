/**
 * F038 · Playwright E2E 隔离环境映射（playwright.config.ts webServer 专用）
 *
 * 与 preview-env.ts 的关系：四个 NEXT_PUBLIC_API_* 布线键 + CORS 语义同构（前端唯一
 * 消费契约），但隔离面独立——preview 是「验收现场」（worktree .runtime 持久 + seed 注入
 * + 全量 scheduler），E2E 是「一次性无菌房」（os.tmpdir 冷启动空库 + scheduler 全关）。
 * 不复用 buildPreviewEnv：它绑死 .runtime/worktree-preview 路径与 WORKTREE_PREVIEW=1
 * seed loader 点火条件，两者语义互斥（德彪 F038 设计审 r1 P1-1）。
 *
 * 隔离开关（实证锚点）：
 * - MULTI_AGENT_SKIP_SCHEDULER=1 → packages/api/src/server.ts:1082（scheduler + wiki reindex 全跳）
 * - MULTI_AGENT_DOCS_WATCHER=0  → packages/api/src/runtime/scheduler-bootstrap.ts:307
 * - WIKI_ROOT                   → packages/api/src/wiki/resolve-wiki-root.ts:40（显式优先级最高）
 */

export type E2eEnv = {
  API_PORT: string
  PORT: string
  CORS_ORIGIN: string
  NEXT_PUBLIC_API_HTTP_URL: string
  NEXT_PUBLIC_API_WS_URL: string
  NEXT_PUBLIC_API_URL: string
  NEXT_PUBLIC_API_BASE_URL: string
  NEXT_PUBLIC_APP_TITLE_PREFIX: string
  SQLITE_PATH: string
  UPLOADS_DIR: string
  RUNTIME_EVENTS_DIR: string
  WIKI_ROOT: string
  MULTI_AGENT_SKIP_SCHEDULER: string
  MULTI_AGENT_DOCS_WATCHER: string
}

/**
 * Iron Law 1 护栏（兜底黑名单，非 tmpdir 白名单）：挡「独立 data 段」（含子路径，
 * 德彪 r2 P3）与 preview 库路径；AppData / data-xyz 这类非独立段不误伤。
 * 调用方约定传 os.tmpdir() 下的一次性目录（playwright.config.ts 是唯一 caller）——
 * 护栏挡的是已知真实数据路径特征，不承诺等价于 tmpdir 强制。
 */
const FORBIDDEN_RUN_ROOT_PATTERNS = [/[\\/]data([\\/]|$)/i, /\.runtime[\\/]worktree-preview/i]

export function buildE2eEnv(input: {
  apiPort: number
  webPort: number
  runRoot: string
}): E2eEnv {
  for (const pattern of FORBIDDEN_RUN_ROOT_PATTERNS) {
    if (pattern.test(input.runRoot)) {
      throw new Error(
        `Iron Law 1: E2E runRoot 命中真实数据路径特征（${pattern}）：${input.runRoot} — 换用 os.tmpdir() 下的一次性目录（护栏是黑名单兜底，合法路径也请遵守 tmpdir 约定）`,
      )
    }
  }
  const apiBase = `http://localhost:${input.apiPort}`
  return {
    API_PORT: String(input.apiPort),
    PORT: String(input.webPort),
    CORS_ORIGIN: `http://localhost:${input.webPort}`,
    NEXT_PUBLIC_API_HTTP_URL: apiBase,
    NEXT_PUBLIC_API_WS_URL: `ws://localhost:${input.apiPort}/ws`,
    NEXT_PUBLIC_API_URL: apiBase,
    NEXT_PUBLIC_API_BASE_URL: apiBase,
    NEXT_PUBLIC_APP_TITLE_PREFIX: "[E2E] ",
    SQLITE_PATH: `${input.runRoot}/e2e.sqlite`,
    UPLOADS_DIR: `${input.runRoot}/uploads`,
    RUNTIME_EVENTS_DIR: `${input.runRoot}/runtime-events`,
    WIKI_ROOT: `${input.runRoot}/wiki-root`,
    MULTI_AGENT_SKIP_SCHEDULER: "1",
    MULTI_AGENT_DOCS_WATCHER: "0",
  }
}
