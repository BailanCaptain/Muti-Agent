import { ImageResponse } from "next/og"
import { PwaIconArt } from "./pwa-icon-art"

// F040 AC14：apple-touch-icon 约定——iOS 添加到主屏用（不透明底，iOS 不吃 alpha）。
export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(<PwaIconArt canvas={180} />, size)
}
