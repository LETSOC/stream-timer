"use client"

import { Suspense, useState, type FormEvent } from "react"
import { useSearchParams } from "next/navigation"

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/"
  return value
}

function LoginForm() {
  const params = useSearchParams()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const send = () => fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      cache: "no-store",
    })
    try {
      // A network error on the first try is usually a stale keep-alive socket (iOS Safari): retry once on a fresh one.
      const response = await send().catch(() => new Promise<Response>((resolve, reject) => setTimeout(() => send().then(resolve, reject), 300)))
      if (response.ok) {
        window.location.assign(safeNext(params.get("next")))
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? `Login failed (${response.status}).`)
    } catch (error) {
      setError(`Could not reach the server (${error instanceof Error ? error.message : "network error"}). Reload the page and try again.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#F6F6F3] px-4 text-black">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-[20px] border border-black/10 bg-white p-6 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
        <div>
          <p className="font-mono text-[12px] tracking-[0.16em] text-black/70 uppercase">Hyphen Festival 2026</p>
          <h1 className="text-xl font-black tracking-tight uppercase">Countdown desk</h1>
        </div>
        <label htmlFor="password" className="block text-[13px] font-bold">Operator password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-xl border border-black/10 bg-[#F6F6F3] px-3 py-2 text-sm"
        />
        {error ? <p role="alert" className="font-mono text-[13px] text-[#a32600]">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !password}
          className="inline-flex h-10 w-full items-center justify-center rounded-full bg-black text-[13px] font-medium text-white transition-all hover:bg-[#222] focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-40"
        >
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
    </main>
  )
}
