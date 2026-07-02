import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

// F036 restyle（对齐 clowder）：拉丁走 Inter（clowder 本体同款，next/font 自托管，中性干净 ≈ Claude），
// 中文走思源黑 Noto Sans SC（<head> 里 Google Fonts <link> 真加载，不落系统雅黑）；等宽 JetBrains Mono。
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const titlePrefix = process.env.NEXT_PUBLIC_APP_TITLE_PREFIX ?? "";

export const metadata: Metadata = {
  title: `${titlePrefix}Multi-Agent`,
  description: "本地多 CLI 会话控制台"
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap"
        />
      </head>
      <body>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
