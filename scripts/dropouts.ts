/**
 * npm run dropouts                 today's operator problem marks first (⚑ Mark: events 15s before → 5s
 *                                   after, YouTube runs behind), then the on-purpose markers (stopped /
 *                                   back on / test: their relay lines are "expected"), then incidents ±5s
 * npm run dropouts -- 2026-11-04   that day (London date)
 * npm run dropouts -- --window 10  wider correlation window (seconds)
 * npm run dropouts -- --all        the whole log, not just incidents
 * npm run dropouts -- --since 10:30   only from that London time on
 * Reads logs/dropouts-YYYY-MM-DD.log (DROPOUT_LOG_DIR overrides the folder).
 */
import fs from "node:fs"
import path from "node:path"
import { annotateExpected, correlate, dropoutDir, formatMark, formatMarkers, formatRow, isMark, isRealProblem, londonParts, markIncidents, parseDropoutLog } from "../lib/dropout-log"

process.stdout.on("error", () => process.exit(0)) // piped into head etc.
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
// Annotate before --since, so a stop / test marked earlier still labels the lines after it.
let events = annotateExpected(parseDropoutLog(files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n")))
const since = opt("--since")
if (since) events = events.filter((e) => londonParts(e.at).time >= since)
/** Upstream → downstream: the earliest link that broke is the likely origin. */
const ORDER = ["ingest", "srt", "relay", "rearm", "switch", "player", "capture", "push", "server"]
const STAGE: Record<string, string> = { ingest: "OBS → relay ingest", srt: "Backup SRT link", relay: "relay (MediaMTX)", rearm: "auto re-arm / arm", switch: "Main/Backup switch", player: "/stream page player (in capture)", capture: "Browser capture (screencast → encoder)", push: "forward → YouTube/destination", server: "server" }

const counts = new Map<string, number>()
for (const e of events) if (isRealProblem(e)) counts.set(e.cat, (counts.get(e.cat) ?? 0) + 1)
const expected = events.filter((e) => e.level === "!" && e.expected && !isMark(e)).length
console.log(`Dropout log ${date} (London time) · ${events.length} events · problems: ${[...counts].map(([c, n]) => `${c} ${n}`).join(", ") || "none"}${expected ? ` · ${expected} expected (operator stopped / test, not counted)` : ""}`)

if (args.includes("--all")) {
  for (const e of events) console.log(`${e.line.slice(11)}${e.expected ? `  ← expected (${e.expected})` : ""}`)
  process.exit(0)
}
const marks = markIncidents(events)
const markers = formatMarkers(events, "   ")
if (marks.length) {
  console.log(`\n══ ${marks.length} operator problem mark${marks.length === 1 ? "" : "s"} (⚑ Mark: blackout / frozen / audio) · YouTube runs several seconds behind the local output: look at what broke BEFORE the mark`)
  marks.forEach((m, i) => console.log(`\n── Mark ${i + 1}\n${formatMark(m, "   ")}`))
}
if (markers.length) {
  console.log(`\n══ ${markers.length} operator marker${markers.length === 1 ? "" : "s"} on purpose (stopped / back on / test / note): relay lines they cause are labelled "expected" and not counted`)
  for (const l of markers) console.log(l)
}
if (marks.length || markers.length) console.log("\n══ All incidents (expected lines shown, not counted)")
const incidents = correlate(events.filter((e) => !isMark(e)), windowMs)
if (!incidents.length) console.log("No incidents (no unexpected \"!\" lines).")
incidents.forEach((inc, i) => {
  const first = inc.problems.slice().sort((a, b) => ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat) || a.at - b.at)[0]
  const dur = (inc.to - inc.from) / 1000
  console.log(`\n── Incident ${i + 1} · ${londonParts(inc.from).time.slice(0, 8)}${dur >= 1 ? `–${londonParts(inc.to).time.slice(0, 8)} (${dur.toFixed(0)}s)` : ""} · ${inc.problems.length} problem line(s)`)
  console.log(`   earliest link in the chain: ${STAGE[first.cat] ?? first.cat} → ${first.msg.slice(0, 140)}`)
  for (const e of inc.context) console.log(formatRow(e, inc.from, " "))
})
