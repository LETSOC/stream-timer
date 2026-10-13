import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Baked into both server and browser bundles: lets an open OBS /stream tab notice a rebuild and reload,
  // instead of running old code that doesn't know new cards (e.g. it turned "welcome" into "none").
  env: { APP_BUILD: process.env.APP_BUILD ?? String(Date.now()), APP_VERSION: process.env.npm_package_version ?? "" },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
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
