/** Pure, client-safe: the latency hint under a revealed SRT URL (OBS/ffmpeg take µs in the URL). */
export function srtLatencyNote(ms: number | undefined | null): string {
  const v = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 300
  return `latency=${v * 1000} is ${v} ms (µs in OBS; set SRT_LATENCY_MS on the server)${v < 1000 ? ". Use 1000 over the internet, 500 on bad Wi-Fi" : ""}`
}
