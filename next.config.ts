import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Baked into both server and browser bundles: lets an open OBS /stream tab notice a rebuild and reload,
  // instead of running old code that doesn't know new cards (e.g. it turned "welcome" into "none").
  env: { APP_BUILD: process.env.APP_BUILD ?? String(Date.now()), APP_VERSION: process.env.npm_package_version ?? "" },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  // Built-in /brand images: immutable when versioned (?v=<build>, lib/brand-asset), else revalidate hourly.
  async headers() {
    return [
      { source: "/brand/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }] },
      { source: "/brand/:file*", has: [{ type: "query", key: "v" }], headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ]
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
}

export default nextConfig
