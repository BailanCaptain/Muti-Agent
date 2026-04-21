const DEFAULT_TITLE_PATTERNS: RegExp[] = [
  /^新会话 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  /^新会话 \d{4}-\d{2}-\d{2}$/,
  /^[FBDQ]-新会话 \d{4}-\d{2}-\d{2}$/,
  /^\d{4}-\d{2}-\d{2} · 未命名$/,
]

export function isDefaultTitle(title: string): boolean {
  const trimmed = (title ?? "").trim()
  if (!trimmed) return false
  return DEFAULT_TITLE_PATTERNS.some((re) => re.test(trimmed))
}
