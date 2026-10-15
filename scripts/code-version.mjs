// Short hash of the Browser capture's code (this file's siblings). The running capture reports the
// hash it started with; the server compares it with the files on disk → "restart to use new code".
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
export const CAPTURE_CODE_FILES = ["capture-stream.mjs", "audio-feeder.mjs", "program-jitter.mjs"]
export function captureCodeVersion(dir) {
  const h = crypto.createHash("sha1")
  for (const f of CAPTURE_CODE_FILES) { try { h.update(fs.readFileSync(path.join(dir, f))) } catch { h.update(`missing:${f}`) } }
  return h.digest("hex").slice(0, 10)
}
