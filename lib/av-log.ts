import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { parseJsonl, type AvSample } from "@/lib/av-diagnostics"

export const avLogFile = () => path.join(DATA_DIR, "av-log.jsonl")
const MAX_BYTES = 5_000_000

export function appendAvSample(sample: AvSample) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    if (fs.statSync(avLogFile()).size > MAX_BYTES) fs.renameSync(avLogFile(), `${avLogFile()}.1`)
  } catch { /* new file */ }
  fs.appendFileSync(avLogFile(), `${JSON.stringify(sample)}\n`)
}

export function readAvSamples(): AvSample[] {
  try {
    return parseJsonl(fs.readFileSync(avLogFile(), "utf8"))
  } catch {
    return []
  }
}

/** Start a new test: the old log is kept as av-log.<time>.jsonl, never deleted. */
export function archiveAvLog(now = Date.now()): string | null {
  if (!fs.existsSync(avLogFile())) return null
  const dest = path.join(DATA_DIR, `av-log.${new Date(now).toISOString().replace(/[:.]/g, "-")}.jsonl`)
  fs.renameSync(avLogFile(), dest)
  return path.basename(dest)
}
