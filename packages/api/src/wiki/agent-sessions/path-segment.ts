/**
 * F027 P8 范-r1 P1-1 修：path segment containment
 *
 * roomId / alias 直接拼到文件路径（wiki/rooms/<roomId>/agent-sessions/<alias>/...）。
 * caller 是 RoomCompiler / message-service，最终来源含人输入（@ alias），
 * attacker 可造 alias = '../escape' 或含 Windows 非法字符让文件写到 wikiRoot 外
 * 或在 Windows 上整 archive 失败。
 *
 * 防御：在 DB 写入边界（createSession）+ 文件布局边界（computeAgentSessionLayout）
 * 双重校验。拒绝以下：
 *   - 空字符串、NUL byte
 *   - 路径分隔符 '/' '\\'
 *   - 父目录跳出 '..'、当前目录 '.'（独立段）
 *   - Windows 非法字符 < > : " | ? *
 *   - Windows 保留 device 名 (CON / PRN / AUX / NUL / COMx / LPTx) 大小写
 *   - 控制字符 0x00-0x1F
 *   - 段尾 '.' 或空白（Windows 自动剥离造成歧义）
 *   - 段首 '-'（避免 CLI/git 误解）
 */

export class InvalidPathSegmentError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly value: string,
    reason: string,
  ) {
    super(`invalid path segment for ${fieldName}=${JSON.stringify(value)}: ${reason}`)
    this.name = "InvalidPathSegmentError"
  }
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
])

/**
 * 校验单段（不含路径分隔符的 string）能否安全做文件系统目录 / 文件名段。
 * 失败抛 InvalidPathSegmentError；成功返回原字符串。
 */
export function assertSafePathSegment(fieldName: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidPathSegmentError(fieldName, value, "must be non-empty string")
  }
  if (value.includes("\0")) {
    throw new InvalidPathSegmentError(fieldName, value, "must not contain NUL byte")
  }
  if (value === "." || value === "..") {
    throw new InvalidPathSegmentError(fieldName, value, "must not be '.' or '..' (parent escape)")
  }
  if (/[/\\]/.test(value)) {
    throw new InvalidPathSegmentError(fieldName, value, "must not contain path separators")
  }
  // Windows 非法字符：<>:"|?*
  if (/[<>:"|?*]/.test(value)) {
    throw new InvalidPathSegmentError(
      fieldName,
      value,
      'must not contain invalid character ([<>:"|?*])',
    )
  }
  // 控制字符 0x00-0x1F（用 charCodeAt 避免 biome noControlCharactersInRegex）
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20) {
      throw new InvalidPathSegmentError(fieldName, value, "must not contain control characters")
    }
  }
  // 段尾 '.' 或空白（Windows 自动剥）
  if (/[.\s]$/.test(value)) {
    throw new InvalidPathSegmentError(
      fieldName,
      value,
      "must not end with '.' or whitespace (Windows auto-strip)",
    )
  }
  // 段首 '-'（CLI/git 误解）
  if (value.startsWith("-")) {
    throw new InvalidPathSegmentError(fieldName, value, "must not start with '-'")
  }
  // Windows 保留 device 名（不含扩展名也算）
  const baseUpper = value.split(".")[0].toUpperCase()
  if (WINDOWS_RESERVED.has(baseUpper)) {
    throw new InvalidPathSegmentError(
      fieldName,
      value,
      `must not be Windows reserved device name (${baseUpper})`,
    )
  }
  return value
}
