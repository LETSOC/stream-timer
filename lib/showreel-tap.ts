/** Float stereo → s16le interleaved, base64 (what window.__showreelPcm takes). */
export function pcmChunkB64(l: Float32Array, r: Float32Array): string {
  const out = new Int16Array(l.length * 2)
  for (let i = 0; i < l.length; i++) {
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)))
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)))
  }
  const bytes = new Uint8Array(out.buffer)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
