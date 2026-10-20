"use client"
/**
 * /stream image preloader. The countdown, speaker slides and cards used plain <img> tags that only
 * started downloading when they mounted, so their text painted first and the picture popped in later
 * (in the YouTube capture too). Now every image the page can show is fetched and decoded up front and
 * kept in memory, and each card/slide waits for its own image (max ~2s, so nothing blocks forever).
 */
import { useEffect, useState } from "react"
import { safeUrl } from "@/lib/event"

export const IMAGE_WAIT_MS = 2000

type Entry = { img: HTMLImageElement; done: boolean; promise: Promise<void> }
// Module cache: decoded images stay referenced (in memory) for the life of the page.
const cache = new Map<string, Entry>()

/** Start (once) fetching + decoding `url`. Resolves when decoded or failed (never rejects). */
export function preloadImage(url: string): Promise<void> {
  if (!url || typeof Image === "undefined") return Promise.resolve()
  const hit = cache.get(url)
  if (hit) return hit.promise
  const img = new Image()
  img.decoding = "async"
  const entry: Entry = { img, done: false, promise: Promise.resolve() }
  entry.promise = new Promise<void>((resolve) => {
    const finish = () => { entry.done = true; resolve() }
    img.onload = () => { img.decode().then(finish, finish) }
    img.onerror = finish
    img.src = url
  })
  cache.set(url, entry)
  return entry.promise
}

export function preloadImages(urls: readonly string[]): Promise<void> {
  return Promise.all(urls.map(preloadImage)).then(() => undefined)
}

export function imageReady(url: string): boolean {
  return !url || cache.get(url)?.done === true
}

/** Resolves when `url` is decoded, or after `timeoutMs`. */
export function waitForImage(url: string, timeoutMs = IMAGE_WAIT_MS): Promise<void> {
  if (imageReady(url)) return Promise.resolve()
  return Promise.race([preloadImage(url), new Promise<void>((r) => setTimeout(r, timeoutMs))])
}

/** True once every url is decoded (or the timeout passed). Empty urls count as ready. */
export function useImagesReady(urls: readonly string[], timeoutMs = IMAGE_WAIT_MS): boolean {
  const key = urls.filter(Boolean).join("\n")
  const [readyKey, setReadyKey] = useState<string | null>(() => (urls.every(imageReady) ? key : null))
  useEffect(() => {
    let cancelled = false
    void Promise.all(urls.map((u) => waitForImage(u, timeoutMs))).then(() => { if (!cancelled) setReadyKey(key) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the joined urls
  }, [key, timeoutMs])
  return readyKey === key
}

const img = (v: string) => safeUrl(v, "", { relative: true, dataImage: true })

/** Pure: every image /stream may show for this stage (cards, logo, speaker photos, brand fallbacks). */
export function stageImageUrls(stage: { logoUrl: string; speakers: { image: string }[]; breakImage: string; holdImage: string; welcomeImage: string }, brand: (p: string) => string = (p) => p): string[] {
  const urls = [
    img(stage.logoUrl) || brand("/brand/hyphen-emerald.png"),
    brand("/brand/rsvp-qr.png"),
    brand("/brand/end-qr.png"),
    img(stage.breakImage),
    img(stage.holdImage),
    img(stage.welcomeImage),
    ...stage.speakers.map((s) => img(s.image)),
  ].filter(Boolean)
  return [...new Set(urls)]
}
