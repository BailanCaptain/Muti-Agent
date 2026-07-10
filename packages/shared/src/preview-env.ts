/**
 * F028 Task 0 · worktree preview 环境映射单一真相源（自 scripts/worktree-preview.ts 原样迁移）
 *
 * 迁移动机（plan v3 "F024 复用边界"）：packages/api tsconfig rootDir:"src" 无法 import
 * 仓库根 scripts/；F028 preview 编排器（主 API 内）与 F024 CLI 必须共用同一份 env 映射，
 * 否则 25 行纯映射出现双份漂移。scripts/worktree-preview.ts 改为 re-export 本模块，
 * F024 既有测试零改动保持绿（契约回归锚）。
 *
 * F027 P4 AC-P4-9 d5: WORKTREE_PREVIEW=1 是 worktree-preview-only seed loader 的
 * primary gate（与 SQLITE_PATH 含 .runtime/worktree-preview/ 双保险）。生产启动
 * 永不设置此变量 → seed loader 在生产恒关。spawn 出的 API 子进程经 childEnv 继承。
 */

export type PreviewEnv = {
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
  WORKTREE_PREVIEW: string
}

export function buildPreviewEnv(input: {
  repoRoot: string
  worktreeName: string
  apiPort: number
  webPort: number
  /**
   * F040 T7：私有组网（Tailscale/LAN）真机联调 — 手机上 localhost 指向手机自己，
   * NEXT_PUBLIC 四址必须烤成本机组网 IP。设置后 CORS 变双白名单（本机 localhost
   * 调试 + 手机组网 origin 同时放行，parseCorsOrigin 原生支持逗号列表）。
   * 注意 spawn 用 { ...process.env, ...env } 生成值优先——外层直接传 NEXT_PUBLIC_*
   * 会被本函数产物覆盖（T7 真机实证），必须走这个参数。
   */
  publicHost?: string
}): PreviewEnv {
  const host = input.publicHost?.trim() || "localhost"
  const apiBase = `http://${host}:${input.apiPort}`
  const corsOrigin =
    host === "localhost"
      ? `http://localhost:${input.webPort}`
      : `http://localhost:${input.webPort},http://${host}:${input.webPort}`
  return {
    API_PORT: String(input.apiPort),
    PORT: String(input.webPort),
    CORS_ORIGIN: corsOrigin,
    NEXT_PUBLIC_API_HTTP_URL: apiBase,
    NEXT_PUBLIC_API_WS_URL: `ws://${host}:${input.apiPort}/ws`,
    NEXT_PUBLIC_API_URL: apiBase,
    NEXT_PUBLIC_API_BASE_URL: apiBase,
    NEXT_PUBLIC_APP_TITLE_PREFIX: `[${input.worktreeName}] `,
    SQLITE_PATH: `${input.repoRoot}/.runtime/worktree-preview/data/multi-agent.sqlite`,
    UPLOADS_DIR: `${input.repoRoot}/.agents/acceptance/uploads`,
    RUNTIME_EVENTS_DIR: `${input.repoRoot}/.agents/acceptance/runtime-events`,
    WORKTREE_PREVIEW: "1",
  }
}
