/**
 * F040 T7 修8（德彪 r7 P1）：/uploads 静态响应硬化。上传目录字节不可信（agent
 * send_file 产物、web 上传（含 svg）、飞书下载），而 <a download> 对跨源 URL 不生效
 * （download 属性 same-origin only；web/API 双端口天然跨源）——导航打开 html/svg
 * 会在 API origin 执行脚本 = 存储型 XSS，可同源调 API。
 * 三头：attachment=导航一律下载；nosniff=禁 MIME 嗅探；CSP sandbox=就算被渲染也
 * 无脚本无同源。<img> 等子资源加载不受 Content-Disposition/文档 CSP 影响，内联图零回归。
 * 参数取最小结构面（@fastify/static v8 的 SetHeadersResponse 与 node ServerResponse 都满足）。
 */
export function setUploadResponseHeaders(res: {
  setHeader(name: string, value: string): void
}): void {
  res.setHeader("content-disposition", "attachment")
  res.setHeader("x-content-type-options", "nosniff")
  res.setHeader("content-security-policy", "sandbox")
}
