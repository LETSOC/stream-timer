<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

The operator desk is `npm run dev` (Next.js plus the phone-deck WebSocket) at http://127.0.0.1:43211. Leave `BIND_HOST` unset so the process stays on loopback in local mode. A non-loopback bind turns on password login.

`npm test` is the unit suite. `npm run stream:test` encodes a short countdown MP4 with the live FFmpeg filtergraph; it needs system `ffmpeg` (drawtext) and the fonts already in `assets/fonts/`. `npm run build` is the typecheck that passes here. `npx tsc --noEmit` before Next has generated route types reports missing `LayoutProps` / `RouteContext`. `npm run lint` currently reports existing desk errors; the production build still completes.

Browser capture (`scripts/capture-stream.mjs`) needs Playwright Chromium: `npx playwright install --with-deps chromium`. The relay looks for MediaMTX at `bin/mediamtx` (gitignored): `bash scripts/install-mediamtx.sh v1.21.2`. `npm ci` does not install either of those. Runtime state lives in gitignored `data/`.
