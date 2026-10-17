"use client"

import { useEffect, useState } from "react"
import { HEARTBEAT_STALE_MS, syncFlash, syncTestContext, syncTimecode } from "@/lib/sync-test"

const ID = "__stream_sync_test"

/**
 * /stream's A/V sync test overlay: always-on timecode (HH:MM:SS:FF, :00 = beep frame), 200ms near-white
 * flash, top bar that turns orange on the beep. Drawn on document.body (outside React) with a heartbeat
 * (dataset.hb): a watchdog re-creates the node if a remount/reload removed it or its rAF loop stalled.
 * Only in Browser capture with the desk's capture "A/V sync test" on (or ?synctest=1); never in operator previews.
 */
export function SyncTestOverlay({ timeZone, fps = 30 }: { timeZone: string; fps?: number }) {
  const [on, setOn] = useState(false)

  useEffect(() => {
    const ctx = syncTestContext(window.location.search, navigator.userAgent, navigator.webdriver === true, window.self !== window.top)
    if (!ctx) return
    if (ctx === "forced") { setOn(true); return }
    let alive = true
    const poll = async () => {
      try {
        const r = await fetch("/api/sync-test", { cache: "no-store" })
        const body = (await r.json()) as { on?: boolean }
        if (alive) setOn(body.on === true)
      } catch { /* keep last */ }
    }
    void poll()
    const id = window.setInterval(poll, 2000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!on) { document.getElementById(ID)?.remove(); return }
    let raf = 0
    const ensure = () => {
      let root = document.getElementById(ID)
      const hb = Number(root?.dataset.hb || 0)
      if (root?.isConnected && hb > Date.now() - HEARTBEAT_STALE_MS) return root
      root?.remove()
      root = document.createElement("div")
      root.id = ID
      root.setAttribute("data-testid", "av-sync-test")
      root.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:Arial,Helvetica,sans-serif"
      root.innerHTML =
        '<div data-part="flash" style="position:absolute;inset:0;background:#fff;opacity:0"></div>' +
        '<div data-part="bar" style="position:absolute;left:0;right:0;top:0;height:1.2vw;background:#D9FF43"></div>' +
        '<div data-part="label" style="position:absolute;left:3.5vw;top:3vw;padding:1vw 1.6vw;border:0.25vw solid #D9FF43;border-radius:1vw;background:rgba(0,0,0,0.78);color:#D9FF43">' +
        '<div style="font-size:1vw;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85">A/V sync test · :00 = beep</div>' +
        '<div data-part="tc" style="font-size:5vw;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1"></div>' +
        '<div data-part="state" style="font-size:1.6vw;font-weight:800"></div></div>'
      root.dataset.hb = String(Date.now())
      document.body.appendChild(root)
      return root
    }
    const paint = () => {
      const root = ensure()
      const now = Date.now()
      const beep = syncFlash(now)
      root.dataset.hb = String(now)
      root.dataset.beep = beep ? "1" : "0"
      const q = (p: string) => root.querySelector<HTMLElement>(`[data-part=${p}]`)!
      q("flash").style.opacity = beep ? "0.92" : "0"
      const c = beep ? "#ff3c00" : "#D9FF43"
      q("bar").style.background = c
      q("label").style.borderColor = c
      q("label").style.color = c
      q("tc").textContent = syncTimecode(now, fps, timeZone)
      q("state").textContent = beep ? "● BEEP / FLASH" : "· silence"
    }
    const tick = () => { paint(); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    // Watchdog: rAF can stall (throttled/remounted page); repaint + re-create from a timer too.
    const dog = window.setInterval(paint, 250)
    return () => { cancelAnimationFrame(raf); window.clearInterval(dog); document.getElementById(ID)?.remove() }
  }, [on, fps, timeZone])

  return null
}
