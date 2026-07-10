import path from "node:path"

/**
 * F040 T7 修10（德彪 r7 P2）：/uploads 单层 URL 的 basename 提取 + 容器复核，三消费点
 * 共用（final-message-reader 出站白名单 / resolveAttachmentPath 注入路径 /
 * readUploadFile 出站读字节），防各自为政漂移。
 *
 * 单层正则挡不住 "."/".."（basename+resolve 拿 ".." 直接逃出容器：/uploads/.. →
 * uploadsDir 父目录），显式除名；":" 一并拒——win32 驱动器相对路径（"C:x"）经 resolve
 * 会逃根，而合法存储名全是 uuid / agent-时间戳 / feishu-uuid，不含冒号。
 * 编码 dot（%2e%2e）不解码 = 字面文件名，fs 无二次解码，无穿越面，照常放行。
 */
export function uploadBasename(rawPath: string): string | null {
  const m = /^\/uploads\/([^/\\:]+)$/.exec(rawPath)
  if (!m) return null
  const name = m[1]
  if (name === "." || name === "..") return null
  return name
}

/** basename → 容器内绝对路径；解析后必须仍是 root 直下单段（path.relative 复核兜底），否则 null。 */
export function containedUploadPath(rootDir: string, name: string): string | null {
  const root = path.resolve(rootDir)
  const candidate = path.resolve(root, name)
  const rel = path.relative(root, candidate)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || /[\\/]/.test(rel)) return null
  return candidate
}
