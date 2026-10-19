/**
 * npm run dropouts                 today's incidents, each with every event ±5s around it
 * npm run dropouts -- 2026-11-04   that day (London date)
 * npm run dropouts -- --window 10  wider correlation window (seconds)
 * npm run dropouts -- --all        the whole log, not just incidents
 * npm run dropouts -- --since 10:30   only from that London time on
 * Reads logs/dropouts-YYYY-MM-DD.log (DROPOUT_LOG_DIR overrides the folder).
 */
import fs from "node:fs"
import path from "node:path"
import { correlate, dropoutDir, londonParts, parseDropoutLog, type DropEvent } from "../lib/dropout-log"

const args = process.argv.slice(2)
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const windowMs = Number(opt("--window") ?? 5) * 1000
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? (args.includes("yesterday") ? londonParts(Date.now() - 86_400_000).date : londonParts(Date.now()).date)
const dir = dropoutDir()
const files = (() => { try { return fs.readdirSync(dir).filter((n) => n.startsWith(`dropouts-${date}`)).sort() } catch { return [] } })()
if (!files.length) {
  console.log(`No dropout log for ${date} in ${dir}. (It's written while the server runs: npm start.)`)
  process.exit(0)
}
let events = parseDropoutLog(files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n"))
const since = opt("--since")
if (since) events = events.filter((e) => londonParts(e.at).time >= since)
const t = (e: DropEvent) => londonParts(e.at).time
/** Upstream → downstream: the earliest link that broke is the likely origin. */
const ORDER = ["ingest", "srt", "relay", "rearm", "switch", "player", "capture", "push", "server"]
const STAGE: Record<string, string> = { ingest: "OBS → relay ingest", srt: "Backup SRT link", relay: "relay (MediaMTX)", rearm: "auto re-arm / arm", switch: "Main/Backup switch", player: "/stream page player (in capture)", capture: "Browser capture (screencast → encoder)", push: "forward → YouTube/destination", server: "server" }

const counts = new Map<string, number>()
for (const e of events) if (e.level === "!") counts.set(e.cat, (counts.get(e.cat) ?? 0) + 1)
console.log(`Dropout log ${date} (London time) · ${events.length} events · problems: ${[...counts].map(([c, n]) => `${c} ${n}`).join(", ") || "none"}`)

if (args.includes("--all")) {
  for (const e of events) console.log(e.line.slice(11))
  process.exit(0)
}
const incidents = correlate(events, windowMs)
if (!incidents.length) console.log("No incidents (no \"!\" lines).")
incidents.forEach((inc, i) => {
  const first = inc.problems.slice().sort((a, b) => ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat) || a.at - b.at)[0]
  const dur = (inc.to - inc.from) / 1000
  console.log(`\n── Incident ${i + 1} · ${londonParts(inc.from).time.slice(0, 8)}${dur >= 1 ? `–${londonParts(inc.to).time.slice(0, 8)} (${dur.toFixed(0)}s)` : ""} · ${inc.problems.length} problem line(s)`)
  console.log(`   earliest link in the chain: ${STAGE[first.cat] ?? first.cat} → ${first.msg.slice(0, 140)}`)
  for (const e of inc.context) {
    const rel = (e.at - inc.from) / 1000
    console.log(`   ${t(e)} ${rel >= 0 ? "+" : "−"}${Math.abs(rel).toFixed(1).padStart(4)}s ${e.level} [${e.cat}] ${e.msg}`)
  }
})
