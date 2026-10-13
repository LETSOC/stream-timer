# Auth plan (not implemented yet)

Goal: one operator password now, GitHub/Google OAuth later. Same code runs solo on a MacBook (`npm run dev`, `127.0.0.1:43211`) and in the cloud.

## Where things stand (main + `fix/encoder-followups`)

| Piece | File | Today |
|---|---|---|
| Locality check | `lib/encoder-auth.ts` (`isLoopbackRequest`, `originAllowed`, `authorizeMutation`) | Local only if bound to loopback, every proxy hop local, `Host` local. Mutations also need the token and a local `Origin`. |
| Token | `lib/encoder-auth.ts` (`getEncoderToken`), `data/encoder-token` (0600) or `ENCODER_TOKEN` | Handed to *any local caller* by `GET /api/event` and `GET /api/encoder`. |
| Client | `lib/use-encoder-token.ts`, `components/operator-console.tsx`, `components/encoded-preview.tsx` | Fetch the token, send `x-encoder-token` on PUT/POST/DELETE. |
| Read endpoints | `app/api/event/route.ts` GET, `app/api/encoder/route.ts` GET | Public. `/stream` and `/end` poll `/api/event`; the desk polls both. |
| Public pages | `app/stream/page.tsx`, `app/end/page.tsx`, `app/media/[file]/route.ts` | No auth. OBS loads these. |
| Console | `app/page.tsx` → `OperatorConsole` | No auth. |

There is no `proxy.ts` (Next 16's name for middleware) yet.

## 1. Password login

- **Config**: `OPERATOR_PASSWORD_HASH` (preferred, scrypt via `node:crypto`, format `scrypt$N$r$p$salt$hash`) or `OPERATOR_PASSWORD` (plain, local convenience). Add `npm run hash-password` (a ~20-line script) to make the hash. Compare with `crypto.timingSafeEqual` on the derived key. No new dependency.
- **Session secret**: `SESSION_SECRET` (32+ random bytes). Missing in cloud mode = refuse to start.
- **Login page**: `app/login/page.tsx` (one password field, posts to a server action or `POST /api/auth/login`). Redirects back to `?next=` (only same-origin paths).
- **Session cookie**: `st_session` = `base64url(payload).HMAC-SHA256(payload)` with payload `{ v:1, sub:"operator", iat, exp }` (12 h, sliding refresh when < 2 h left). Flags `HttpOnly; SameSite=Lax; Path=/; Secure` (Secure skipped only on plain-http loopback). Stateless, so it works with one server and no DB. "Log out everywhere" = rotate `SESSION_SECRET` or bump a `SESSION_VERSION` env.
- **Logout**: `POST /api/auth/logout` clears the cookie (POST + Origin check, not GET).
- **Rate limit / lockout**: in-memory per client key (in cloud, the IP from a trusted proxy header; locally, a single bucket). 5 failures → 30 s delay, doubling to a 15 min cap; always add ~300 ms to failures. Log failures without the password. In-memory is fine for one instance; note it resets on restart.
- **CSRF**: SameSite=Lax + the existing `originAllowed` check on every mutation. Keep both.

## 2. What it protects, and the encoder token

Gate with a new `lib/auth.ts` (`getSession(request)`, `requireOperator(request)`) and a `proxy.ts` for page redirects:

| Route | Rule |
|---|---|
| `/` console | Session required → redirect to `/login`. |
| `PUT /api/event` | Session + Origin. |
| `POST`/`DELETE /api/encoder` | Session + Origin. |
| `GET /api/encoder` (status, log tails, stray pids) | Session (it shows redacted logs and process info). |
| Token hand-out in `GET /api/event` / `GET /api/encoder` | **Removed.** |

`AUTH_MODE` env:
- `local` (default when `BIND_HOST` is loopback and no password is set): today's behaviour. The loopback check counts as a session, so `npm run dev` on the Mac needs no login. Opt in to the password locally by setting `OPERATOR_PASSWORD`.
- `password` (default whenever `OPERATOR_PASSWORD(_HASH)` is set, and required when `BIND_HOST` isn't loopback): always log in, loopback included.
- later `oauth`.

The encoder token stays only as a **machine credential**: `Authorization: Bearer $ENCODER_TOKEN` for scripts or curl. It is never sent to browsers. `lib/use-encoder-token.ts` is deleted; browser calls rely on the cookie (`credentials: "same-origin"` is the default). `authorizeMutation` becomes: session OR (valid bearer token AND (local OR `ENCODER_ALLOW_REMOTE=1`)), plus Origin when the request comes from a browser.

## 3. OBS pages without login

**Recommendation: a separate read-only view key.**
- `VIEW_KEY` env, or auto-generated into `data/view-key` (0600) like the encoder token. Long and random (32 bytes, base64url).
- OBS URLs become `/stream?k=…`, `/end?k=…`. The pages send it to `GET /api/public/state?k=…`, and the HLS player uses `/media/stream.m3u8?k=…` (rewrite segment URLs, or set a short-lived `st_view` cookie on first hit).
- The desk's "Copy OBS URL" includes the key. A "Rotate view key" button lives on the desk.
- Local mode: the key is optional, so existing OBS scenes keep working (`REQUIRE_VIEW_KEY=1` turns it on). Cloud: required.

Why not fully public: in the cloud the URL is guessable, and the stage data (event links, speaker images, timing controls such as `forceEnd`) shouldn't be readable or scrapable by anyone. A view key costs nothing in OBS.

**Public read model**: a new `GET /api/public/state` returning only what the pages render: `event` (minus nothing secret), `testUntil`, `pausedAt`, `stage`. Never: token, `hasSaved`, RTMP URL/state/logs, pids, stray publishers. `GET /api/event` becomes operator-only, and `/stream` and `/end` switch to the public route.

## 4. Cloud deployment notes

- **Host**: ffmpeg + `rtmp-supervisor.sh` need a long-running process and a writable disk, so use Fly.io, Railway, Render (paid web service), or a small VPS. **Not Vercel or other serverless**: no background processes, ephemeral filesystem.
- **Docker**: Node 22 + `ffmpeg` + `bash` + `procps` (for `ps`/`pgrep`), `npm run build && npm run start`, `BIND_HOST=0.0.0.0` inside the container.
- **HTTPS**: terminated by the platform or Caddy. Cookies use `Secure`.
- **Proxy trust**: behind the proxy, `isLoopbackRequest` (correctly) says "remote" for every request. With `AUTH_MODE=password` that's fine: locality no longer grants access. Add `TRUST_PROXY=1` only for picking the client IP for rate limiting (rightmost untrusted `X-Forwarded-For` hop), never for auth.
- **Secrets as env**: `OPERATOR_PASSWORD_HASH`, `SESSION_SECRET`, `VIEW_KEY`, `ENCODER_TOKEN` (optional), `RTMP_ALLOWED_HOSTS=castr.io`. The RTMP URL is entered in the desk today and kept in the browser's `localStorage` (`hyphen-countdown-rtmp`). In the cloud, consider `RTMP_URL` env or a server-side 0600 file so it isn't pasted per browser.
- **Persistence**: mount a volume at `data/` (holds `event.json`, `view-key`, `encoder-token`, logs, HLS). Without one, a redeploy resets the event and keys.
- **Single instance**: the locks, rate limiter and pidfiles are per process. Run 1 instance.
- **Mac launchd** (`deploy/com.letsoc.stream-timer.plist`) stays local mode.

## 5. Upgrade to OAuth later

- Add Auth.js (`next-auth` v5) with GitHub and Google providers, JWT session strategy (no DB), and the same `st_session`-style httpOnly cookie that Auth.js manages.
- `OPERATOR_EMAILS=costel@…,…` allowlist checked in the `signIn` callback (verified emails only). Optional `OPERATOR_GITHUB_LOGINS`.
- `lib/auth.ts` keeps `getSession`/`requireOperator` as the single entry point, so routes don't change. Only its implementation switches on `AUTH_MODE`.
- The password stays as a break-glass fallback (`AUTH_ALLOW_PASSWORD=1`) or is removed.
- View key and bearer token are unchanged.

## 6. Implementation checklist

| # | Step | Files | Size |
|---|---|---|---|
| 1 | `lib/auth.ts`: scrypt verify, HMAC cookie sign/verify, `getSession`, `requireOperator`, `AUTH_MODE` resolution; unit tests | new `lib/auth.ts`, `lib/auth.test.ts` | M (~150 lines) |
| 2 | Login/logout routes + page + rate limiter; `scripts/hash-password.mjs` | `app/login/page.tsx`, `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`, `lib/rate-limit.ts` | M |
| 3 | `proxy.ts` redirecting `/` to `/login` when no session (skip `/stream`, `/end`, `/media`, `/api/public`, `/login`, static files) | new `proxy.ts` | S |
| 4 | Gate the APIs: replace token checks with `requireOperator` (+ bearer for machines); remove token hand-out | `lib/encoder-auth.ts`, `app/api/event/route.ts`, `app/api/encoder/route.ts` | S–M |
| 5 | Client: drop `useEncoderToken`; handle 401 → redirect to login; add a logout button to the header | `lib/use-encoder-token.ts` (delete), `components/operator-console.tsx`, `components/encoded-preview.tsx` | S |
| 6 | View key: generate/rotate, `GET /api/public/state`, key on `/stream`, `/end`, `/media`; desk copies the URL with the key | `lib/view-key.ts`, `app/api/public/state/route.ts`, `app/stream/page.tsx`, `app/end/page.tsx`, `app/media/[file]/route.ts`, `components/stream-player.tsx`, console | M |
| 7 | Docs + `.env.example` (all new vars), local vs cloud quick start | `README.md`, `.env.example` | S |
| 8 | Deploy: `Dockerfile`, `fly.toml` (or Render blueprint) with a `data/` volume | new files | S–M |
| 9 | Later: Auth.js OAuth + email allowlist | `lib/auth.ts`, `app/api/auth/[...nextauth]` | M |

Steps 1–5 ≈ one focused session; step 6 another; 7–8 when deploying.

**Before starting, confirm**:
1. Should the Mac default stay "no login on loopback"? (Recommended.)
2. View key vs fully public `/stream`? (Recommend view key.)
3. Which cloud host?
4. Should the RTMP URL move server-side in the cloud?
