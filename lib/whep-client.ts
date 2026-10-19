"use client"
/**
 * Browser WHEP player (read-only WebRTC) for operator previews. Resolves once a frame is decoding;
 * rejects on refusal / no frame within `timeoutMs`, so the caller can fall back to HLS.
 * WebRTC carries Opus only: OBS/capture AAC audio is not in it, so previews that need sound use HLS.
 */
export type WhepSession = { stop: () => void }
let offUntil = 0 // server said "fast previews off": don't retry for a while

/** Pure: "/api/relay/hls/<path>/index.m3u8" → "<path>" (null for anything else). */
export function whepPathFromHls(src: string): string | null {
  const m = /^\/api\/relay\/hls\/([A-Za-z0-9_-]+)\/index\.m3u8(?:\?.*)?$/.exec(src)
  return m ? m[1] : null
}

/** How long a "disconnected" WebRTC preview may try to recover before falling back to HLS. */
export const DISCONNECT_GRACE_MS = 6000

export async function playWhep(video: HTMLVideoElement, path: string, opts: { timeoutMs?: number; onFail?: () => void } = {}): Promise<WhepSession> {
  if (typeof RTCPeerConnection === "undefined") throw new Error("no WebRTC")
  if (Date.now() < offUntil) throw new Error("fast previews off")
  const pc = new RTCPeerConnection({ iceServers: [] })
  let location: string | null = null
  let done = false
  const stop = () => {
    if (done) return
    done = true
    pc.close()
    if (location) void fetch(location, { method: "DELETE" }).catch(() => undefined)
    if (video.srcObject) video.srcObject = null
  }
  try {
    pc.addTransceiver("video", { direction: "recvonly" })
    pc.addTransceiver("audio", { direction: "recvonly" })
    const stream = new MediaStream()
    pc.ontrack = (e) => stream.addTrack(e.track)
    await pc.setLocalDescription(await pc.createOffer())
    // Non-trickle: wait (briefly) for host candidates; the LAN needs no STUN.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve()
      const t = setTimeout(resolve, 800)
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve() } })
    })
    const res = await fetch(`/api/relay/whep/${path}`, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription!.sdp, cache: "no-store" })
    if (res.status === 409) offUntil = Date.now() + 30_000
    if (res.status !== 201) throw new Error(`WHEP ${res.status}`)
    location = res.headers.get("location")
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() })
    video.srcObject = stream
    video.muted = true
    void video.play().catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), opts.timeoutMs ?? 3000)
      const ok = () => { clearTimeout(t); resolve() }
      const check = () => (video.readyState >= 2 && video.videoWidth > 0 ? ok() : setTimeout(check, 100))
      check()
    })
    // "disconnected" is often a Wi-Fi blip that ICE recovers from: give it DISCONNECT_GRACE_MS before
    // giving up (the HLS underneath takes over then). "failed"/"closed" end it at once.
    let grace: ReturnType<typeof setTimeout> | null = null
    pc.addEventListener("connectionstatechange", () => {
      if (done) return
      const st = pc.connectionState
      if (grace && st !== "disconnected") { clearTimeout(grace); grace = null }
      if (st === "failed" || st === "closed") { stop(); opts.onFail?.() }
      else if (st === "disconnected" && !grace) grace = setTimeout(() => { if (!done && pc.connectionState !== "connected") { stop(); opts.onFail?.() } }, DISCONNECT_GRACE_MS)
    })
    return { stop }
  } catch (e) {
    stop()
    throw e
  }
}
