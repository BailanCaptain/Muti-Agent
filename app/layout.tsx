import type { Metadata } from "next";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

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
    <html lang="zh-CN">
      <body>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
