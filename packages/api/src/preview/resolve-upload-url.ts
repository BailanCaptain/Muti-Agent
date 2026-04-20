// Server-generated image blocks (e.g. take_screenshot) land in assistant
// messages with a relative `/uploads/foo.png` URL. The browser loads that
// against the web host (Next dev on a separate port), where fastifyStatic
// isn't mounted, so it 404s. Upload-endpoint blocks avoid this because the
// browser-side uploadFile() prefixes API_BASE at upload time — but agent-
// produced blocks never pass through the browser. This helper mirrors the
// uploadFile() prefix step server-side.
export function resolveUploadUrl(url: string, apiBase: string | undefined): string {
  if (!apiBase) return url
  if (/^https?:\/\//i.test(url)) return url
  if (!url.startsWith("/uploads/")) return url
  return apiBase.replace(/\/+$/, "") + url
}
