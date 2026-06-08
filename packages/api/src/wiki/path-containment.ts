/**
 * F027 P3 [范-r1 P1] · wiki path containment guard —— security 边界
 * 真相源：docs/plans/V16.5-final.md chap 6 + 4（wikiRoot 是边界，path 必须在内）
 *
 * 攻击向量：caller 传 'wiki/concepts/../../../etc/passwd'，ACL 命中
 * 'wiki/concepts/**' 通过，path.join(wikiRoot, relPath) 后实际写到 wikiRoot
 * 之外（passwd / 任意系统文件）。
 *
 * 防御：
 *   1. relPath 必须以 'wiki/' 开头（namespace 边界）
 *   2. path.resolve(wikiRoot, relPath) 必须 startsWith path.resolve(wikiRoot)
 *      (不允许 ../ 逃出，不允许绝对路径覆盖 wikiRoot)
 *   3. 不允许 NUL byte / 控制字符（fs API 边界硬约束）
 */

import { constants as fsConstants, type Stats } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

export class WikiPathInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WikiPathInvalidError"
  }
}

/**
 * F027 · realpath containment + regular-file 读取 —— KB tab 全文端点（drafts/content、warnings/content）共用安全原语。
 *
 * 背景（德彪 codex review NO-GO P1）：safeWikiPath / 子树前缀检查都是**词法**路径检查，
 * 随后的 readFile/stat **会跟随 symlink / Windows junction**。攻击者只要能在受控目录里放一个
 * 指向目录外的链接（项目 taint model 明确把 user-drop 的 symlink 当威胁，DraftScanner.list 已拒），
 * 词法检查就会放行而 readFile 跟随链接读到进程权限内的任意文件。
 *
 * 防御：对**真实路径**再做 containment —— realpath(abs) 解析所有链接后必须仍在 realpath(lexicalRoot)
 * 之内（根也 realpath，兼容根自身位于链接下的部署），且目标必须是**普通文件**（德彪 codex P2：不读
 * 目录/特殊文件，配合各 caller 的 `.md` 限制）。
 *
 * 防御层次（德彪 codex review r1+r2）：
 *   1. realpath(abs) 解析所有 symlink/Windows junction，必须仍在 realpath(lexicalRoot) 内（越界抛）。
 *   2. **单个 FileHandle 做 stat+read**（r2 P1）：关掉 realpath→stat→read 之间 stat→read 的 TOCTOU
 *      窗口（同一 fd 上 fstat 与 read 不会被中途换路径重定向）。
 *   3. **nlink>1 拒绝**（r2 P1）：realpath 不解析 hardlink —— 树内硬链可指向树外文件；多链接文件一律拒。
 *   4. 普通文件校验（非目录/特殊文件）。
 *   ⚠️ 残留：realpath→open 之间仍有极窄 TOCTOU 窗口（纯 userland 路径校验关不死，需 OS 级解析）。
 *      本端点是 localhost 单用户只读 dev 视图、draft/warnings 目录仅由可信 ingest 写入 → 接受此残留。
 *
 * 返回 `{content, mtime}` | `null`（文件或根不存在、或目标非普通文件 → caller 转 404）；
 * 越界 / 多链接（realpath 逃逸 / hardlink）抛 `WikiPathInvalidError`（caller 转 400）。
 */
export async function readContainedFile(
  abs: string,
  lexicalRoot: string,
): Promise<{ content: string; mtime: string } | null> {
  let realRoot: string
  try {
    realRoot = await fsp.realpath(lexicalRoot)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null // 根目录不存在 = 无内容
    throw err
  }
  let realAbs: string
  try {
    realAbs = await fsp.realpath(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null // 文件 / 某路径段不存在
    throw err
  }
  const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (realAbs !== realRoot && !realAbs.startsWith(realRootSep)) {
    throw new WikiPathInvalidError(`path escapes root via symlink/junction: ${abs}`)
  }
  // r2 P1：open 一次，stat + read 都走同一个 FileHandle（关 stat→read TOCTOU）。
  // r3：加 O_NONBLOCK —— 防 FIFO/特殊文件 open 阻塞等 writer（DoS 回归；我换 open-first 引入的）。
  //     POSIX 上 FIFO 以 O_NONBLOCK 打开立即返回，随后 isFile() 判否 → null。Windows 无 O_NONBLOCK
  //     （→ 0）且不会把 FIFO 当目录项，无影响。
  const nonBlock = (fsConstants.O_NONBLOCK as number | undefined) ?? 0
  let handle: Awaited<ReturnType<typeof fsp.open>>
  try {
    handle = await fsp.open(realAbs, fsConstants.O_RDONLY | nonBlock)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EISDIR") return null // 不存在 / 目录 → 当作不存在
    throw err
  }
  try {
    const stat: Stats = await handle.stat()
    if (!stat.isFile()) return null // 目录 / 特殊文件 → 当作不存在
    if (stat.nlink > 1) {
      // r2 P1：realpath 不解析 hardlink —— 多链接文件可能是越界硬链，一律拒。
      throw new WikiPathInvalidError(
        `refusing multi-hardlink file (possible containment escape): ${abs}`,
      )
    }
    const content = await handle.readFile("utf-8")
    return { content, mtime: stat.mtime.toISOString() }
  } finally {
    await handle.close()
  }
}

/**
 * 校验 relPath 在 wikiRoot/wiki/ namespace 内。返回 absolute path（caller 直接 fs IO）。
 * 失败抛 WikiPathInvalidError。
 *
 * relPath 必须满足全部以下条件：
 *   1. 字符串、非空、不含 NUL byte
 *   2. 以 'wiki/' 开头（chap 4 namespace）
 *   3. **normalize 后仍 'wiki/' 开头**（防 'wiki/concepts/../../admin.md' 这种
 *      namespace escape：normalize 'wiki/x/../../admin.md' → 'admin.md'，逃出
 *      wiki/ 子树。范-r2 P1 finding）
 *   4. resolve 后必须 startsWith(resolve(wikiRoot/wiki) + sep)（双保险）
 */
export function safeWikiPath(wikiRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new WikiPathInvalidError("path must be non-empty string")
  }
  if (relPath.includes("\0")) {
    throw new WikiPathInvalidError("path must not contain NUL byte")
  }
  // 1. 字面 'wiki/' 前缀
  if (!relPath.startsWith("wiki/")) {
    throw new WikiPathInvalidError(`path must start with 'wiki/': got '${relPath}'`)
  }
  // 2. [范-r2 P1] normalize 后仍必须在 wiki/ namespace 内（POSIX 风格 normalize，
  //    跨平台保持 '/' 分隔，比 path.normalize 更可预期）
  const posixNormalized = posixNormalize(relPath)
  if (!posixNormalized.startsWith("wiki/")) {
    throw new WikiPathInvalidError(
      `path escapes wiki/ namespace after normalize: '${relPath}' → '${posixNormalized}'`,
    )
  }
  // 3. resolve 后必须在 wikiRoot/wiki/ 子目录下
  const namespaceRoot = path.resolve(wikiRoot, "wiki")
  const targetAbs = path.resolve(wikiRoot, relPath)
  const namespaceWithSep = namespaceRoot.endsWith(path.sep)
    ? namespaceRoot
    : namespaceRoot + path.sep
  if (targetAbs !== namespaceRoot && !targetAbs.startsWith(namespaceWithSep)) {
    throw new WikiPathInvalidError(
      `path resolves outside wikiRoot/wiki: ${relPath} → ${targetAbs} (namespace=${namespaceRoot})`,
    )
  }
  return targetAbs
}

/**
 * POSIX-style normalize: 始终 '/' 分隔，处理 '..' / '.' segments。
 * 不依赖 path.normalize 的平台行为差异（Windows 转 '\' 会让 startsWith('wiki/') 失效）。
 */
function posixNormalize(rel: string): string {
  const segments = rel.split("/")
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (stack.length === 0 || stack[stack.length - 1] === "..") {
        stack.push("..") // 已经逃出 root，记录但不阻止 (caller 检测 startsWith 'wiki/')
      } else {
        stack.pop()
      }
    } else {
      stack.push(seg)
    }
  }
  return stack.join("/")
}
