/**
 * F040 T7 修7 · send_file（agent 出站文件）落盘策略纯核。
 * 只收文本产物：扩展名白名单外一律替换成 .txt（内容本来就是 UTF-8 文本，不存在
 * "错杀二进制"——二进制本工具不支持）。存储名 = 时间戳+随机段（防覆盖防猜，
 * 与 feishu-media / screenshot 同族）；展示名保留调用方语义（回复卡里的文件名、
 * 飞书 file_name 都用它）。路径斩段不走 path.basename（posix 下不认反斜杠，
 * CI/Windows 行为要一致），手工按 [\\/] 切取末段。
 */
export const AGENT_FILE_MAX_BYTES = 1_048_576 // 1MB，对齐 contracts.MAX_INGEST_CONTENT_BYTES

// 德彪 r7 P1：.html/.htm 除名——web/API 双端口跨源下 <a download> 不生效，导航打开
// 即在 API origin 执行脚本（存储型 XSS）。回落 .txt 内容零损失；/uploads 静态服务
// 另有 attachment/nosniff/sandbox 三头兜底（lib/upload-static.ts），双保险。
const TEXT_EXT_ALLOWLIST = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
])

/** 空白/控制符（charCode ≤ 32）收敛成下划线——飞书 file_name 与 Content-Disposition 都嫌它们。 */
function sanitizeSegment(segment: string): string {
  return Array.from(segment)
    .map((ch) => (ch.charCodeAt(0) <= 32 ? "_" : ch))
    .join("")
    .replace(/_+/g, "_")
}

export function prepareAgentFile(
  filenameRaw: string | undefined,
  genId: () => string,
  now: () => number,
): { storedName: string; displayName: string } {
  const trimmed = (filenameRaw ?? "").trim() || "attachment.txt"
  const lastSegment = trimmed.split(/[\\/]+/).pop() || "attachment.txt"
  const base = sanitizeSegment(lastSegment) || "attachment.txt"
  const extMatch = /\.[A-Za-z0-9]{1,10}$/.exec(base)
  const ext =
    extMatch && TEXT_EXT_ALLOWLIST.has(extMatch[0].toLowerCase())
      ? extMatch[0].toLowerCase()
      : ".txt"
  const stem = (extMatch ? base.slice(0, -extMatch[0].length) : base) || "attachment"
  return {
    displayName: `${stem}${ext}`,
    storedName: `agent-${now()}-${genId().slice(0, 8)}${ext}`,
  }
}
