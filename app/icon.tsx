import { ImageResponse } from "next/og"
import { PwaIconArt } from "./pwa-icon-art"

// F040 AC14：App Router icon 约定——自动注入 <link rel="icon">，manifest 引 /icon。
export const size = { width: 512, height: 512 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(<PwaIconArt canvas={512} />, size)
}
