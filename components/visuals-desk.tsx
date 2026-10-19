"use client"

import Link from "next/link"
import { useState } from "react"
import { copyOrShow } from "@/components/copy-fallback"
import { OverlayPreview } from "@/components/visuals-deck"
import { newStrapId, PLATFORM_LABEL, PLATFORMS, STRAP_MAX, STRAP_STYLE_LABEL, STRAP_STYLES, type Platform, type StrapPreset, type StrapStyle } from "@/lib/visuals"

type Props = {
  straps: StrapPreset[]
  accent: string
  text: string
  viewKey: string
  onStraps: (next: StrapPreset[]) => void
  onAccent: (value: string) => void
  onText: (value: string) => void
}

const input = "h-9 w-full rounded-xl border border-black/10 bg-[#F6F6F3] px-3 text-sm"

/** Desk › Visuals: strap preset gallery (draft → Save), colours, and the OBS source URLs. */
export function VisualsDeskSection({ straps, accent, text, viewKey, onStraps, onAccent, onText }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const patch = (i: number, p: Partial<StrapPreset>) => onStraps(straps.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= straps.length) return
    const next = [...straps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onStraps(next)
  }
  const url = (path: string) => (typeof window === "undefined" ? path : `${window.location.origin}${path}${viewKey ? `?k=${encodeURIComponent(viewKey)}` : ""}`)
  const copy = async (id: string, value: string) => {
    if ((await copyOrShow("OBS source URL", value)) !== "copied") return
    setCopied(id)
    window.setTimeout(() => setCopied(null), 1600)
  }
  return (
    <div className="grid gap-4" data-testid="visuals-section">
      <div className="grid gap-2 rounded-xl border border-black/15 p-3" data-testid="visuals-obs-urls">
        <p className="font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">OBS browser sources</p>
        <p className="font-mono text-[12px] text-black/70">Add each as its own Browser Source: Width 1920, Height 1080, no custom CSS needed (the page is transparent). Tick “Shutdown source when not visible” off so motion timing stays right.</p>
        {[{ id: "strap", label: "Name straps", path: "/overlay/strap" }, { id: "socials", label: "Social circles", path: "/overlay/socials" }].map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
            <span className="w-28 shrink-0 font-bold">{o.label}</span>
            <code className="min-w-0 flex-1 truncate rounded-lg bg-[#F6F6F3] px-2 py-1" data-testid={`visuals-url-${o.id}`}>{o.path}{viewKey ? "?k=•••" : ""}</code>
            <button type="button" data-testid={`visuals-copy-${o.id}`} className="rounded-full bg-black px-3 py-1 text-white" onClick={() => void copy(o.id, url(o.path))}>{copied === o.id ? "Copied" : "Copy OBS URL"}</button>
            <a href={`${o.path}?checker=1`} target="_blank" rel="noreferrer" className="rounded-full border border-black/30 px-3 py-1 text-black no-underline">Open</a>
          </div>
        ))}
        <p className="font-mono text-[12px] text-black/70">Go IN / OUT / LOOP and show or hide the socials from the phone <Link href="/visuals" data-testid="desk-visuals-link" className="underline">Visuals deck</Link>.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 font-mono text-[12px] text-black/70 uppercase">Accent colour<input type="color" data-testid="strap-accent" className="h-9 w-full" value={accent} onChange={(e) => onAccent(e.target.value)} /></label>
        <label className="grid gap-1 font-mono text-[12px] text-black/70 uppercase">Text colour<input type="color" data-testid="strap-text" className="h-9 w-full" value={text} onChange={(e) => onText(e.target.value)} /></label>
      </div>

      <div className="grid gap-3" data-testid="strap-gallery">
        <p className="font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">Strap presets ({straps.length}/{STRAP_MAX})</p>
        {straps.map((s, i) => (
          <div key={s.id} className="grid gap-2 rounded-xl border border-black/15 p-3" data-testid={`strap-row-${i}`}>
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Name" placeholder="Name" className={input} value={s.name} maxLength={120} onChange={(e) => patch(i, { name: e.target.value })} />
              <input aria-label="Title" placeholder="Title / role" className={input} value={s.title} maxLength={120} onChange={(e) => patch(i, { title: e.target.value })} />
              <input aria-label="Handle" placeholder="@handle or site" className={input} value={s.handle} maxLength={120} onChange={(e) => patch(i, { handle: e.target.value })} />
              <select aria-label="Platform" className={input} value={s.platform} onChange={(e) => patch(i, { platform: e.target.value as Platform })}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
              <select aria-label="Style" className={input} value={s.style} onChange={(e) => patch(i, { style: e.target.value as StrapStyle })}>
                {STRAP_STYLES.map((p) => <option key={p} value={p}>{STRAP_STYLE_LABEL[p]}</option>)}
              </select>
              <div className="flex gap-1">
                <button type="button" className="rounded-full border border-black/30 px-3 text-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="rounded-full border border-black/30 px-3 text-sm" aria-label="Move down" disabled={i === straps.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="ml-auto rounded-full border border-[#b42318] px-3 text-sm text-[#b42318]" onClick={() => onStraps(straps.filter((_, j) => j !== i))}>Remove</button>
              </div>
            </div>
          </div>
        ))}
        <button type="button" data-testid="strap-add" disabled={straps.length >= STRAP_MAX} className="justify-self-start rounded-full bg-black px-4 py-2 font-mono text-[12px] text-white disabled:opacity-40"
          onClick={() => onStraps([...straps, { id: newStrapId(), name: "New speaker", title: "", handle: "", platform: "none", style: "line" }])}>+ Add strap</button>
        <p className="font-mono text-[12px] text-black/60">Edits stay a draft until you press Save. A strap needs a name or a title.</p>
      </div>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-black/15" data-testid="visuals-desk-preview">
        <OverlayPreview path="/overlay/strap?checker=1" />
      </div>
    </div>
  )
}
