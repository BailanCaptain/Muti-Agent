import type { MetadataRoute } from "next"

// F040 AC14：PWA manifest——iPhone Safari「添加到主屏幕」/ Android 安装位。
// Next 自动 serve 于 /manifest.webmanifest 并注入 <link rel="manifest">。
// 色值取 F036 主题终值（globals.css --surface 注释 hex）；standalone = 独立窗口无浏览器框。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Multi-Agent",
    short_name: "Multi-Agent",
    description: "本地多 CLI 会话控制台",
    start_url: "/",
    display: "standalone",
    background_color: "#F6EFE7",
    theme_color: "#F6EFE7",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  }
}
