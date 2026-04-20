import type { NextConfig } from "next";

const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_HTTP_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8787";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    ignoreBuildErrors: true
  },
  async rewrites() {
    return [
      { source: "/uploads/:path*", destination: `${API_ORIGIN}/uploads/:path*` },
    ];
  },
};

export default nextConfig;
