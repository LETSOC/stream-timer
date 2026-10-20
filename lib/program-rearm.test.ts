import test from "node:test"
import assert from "node:assert/strict"
import { FRESH_REARM, noteRelayDisruption, rearmStep, relayQuietUntil, type RearmMemory } from "@/lib/program-rearm"

/** Replay per-tick (500ms) readouts like the program monitor does. */
type S = "up" | "down" | "notready"
type Tick = { t: number; main: S; backup: S; onAir: "main" | "backup"; quietUntil?: number }
function replay(ticks: Tick[]) {
  const mem: Record<"main" | "backup", RearmMemory> = { main: FRESH_REARM, backup: FRESH_REARM }
  const downAt: Record<"main" | "backup", number | null> = { main: null, backup: null }
  const fired: string[] = []
  for (const k of ticks) {
    for (const s of ["main", "backup"] as const) downAt[s] = k[s] === "down" ? (downAt[s] ?? k.t) : null
    for (const s of ["main", "backup"] as const) {
      const other = s === "main" ? "backup" : "main"
      const r = rearmStep(mem[s], { down: k[s] === "down", ready: k[s] === "up", onAir: k.onAir === s, otherDownAt: downAt[other], quietUntil: k.quietUntil ?? 0, now: k.t, enabled: true })
      mem[s] = r.mem
      if (r.fire) fired.push(`${s}@${k.t / 1000}`)
    }
  }
  return fired
}
/** Build ticks from [fromSec, toSec, main, backup, onAir] segments. */
function seq(segs: [number, number, S, S, "main" | "backup", number?][]): Tick[] {
  const out: Tick[] = []
  for (const [a, b, main, backup, onAir, quiet] of segs) for (let t = a * 1000; t < b * 1000; t += 500) out.push({ t, main, backup, onAir, quietUntil: quiet })
  return out
}

test("20:03:29 log: operator disarm/arm — both FAILED the same second, back ~13s later → no re-arm", () => {
  // Even without the quiet window (e.g. a MediaMTX restart we didn't cause), both-at-once is relay-side.
  assert.deepEqual(replay(seq([[0, 60, "up", "up", "main"], [60, 63, "down", "down", "main"], [63, 73, "notready", "notready", "main"], [73, 120, "up", "up", "main"]])), [])
  // Backup goes down one tick later than Main: still the same event.
  assert.deepEqual(replay([...seq([[0, 60, "up", "up", "main"]]), { t: 60000, main: "down", backup: "up", onAir: "main" }, ...seq([[60.5, 63, "down", "down", "main"], [63, 120, "up", "up", "main"]])]), [])
})

test("operator arm/disarm with no Backup publishing: the quiet window stops the re-arm", () => {
  assert.deepEqual(replay(seq([[0, 60, "up", "down", "main"], [60, 63, "down", "down", "main", 68000], [63, 70, "notready", "down", "main", 68000], [70, 120, "up", "down", "main"]])), [])
})

test("single Main Wi-Fi drop while on air → exactly one re-arm after 3s READY", () => {
  const fired = replay(seq([[0, 60, "up", "up", "main"], [60, 66, "down", "up", "main"], [66, 70, "notready", "up", "main"], [70, 200, "up", "up", "main"]]))
  assert.deepEqual(fired, ["main@73"])
  // …and our own kick right after (inside the quiet window it sets) doesn't trigger a second one.
  assert.deepEqual(replay(seq([[0, 60, "up", "up", "main"], [60, 66, "down", "up", "main"], [66, 73.5, "up", "up", "main"], [73.5, 76, "down", "up", "main", 81500], [76, 200, "up", "up", "main"]])), ["main@69"])
})

test("21:09 log: Main dropped while OFF air, Backup drops → failover to healthy Main → no re-arm", () => {
  assert.deepEqual(replay(seq([
    [0, 60, "up", "up", "backup"],
    [60, 68, "down", "up", "backup"], // 21:08:39 Main FAILED (Backup on air)
    [68, 77, "up", "up", "backup"],
    [77, 79, "up", "down", "backup"], // 21:09:33 Backup FAILED
    [79, 200, "up", "down", "main"], // 21:09:35 auto-failover Backup → Main (Main already healthy)
  ])), [])
})

test("a source that never was READY on air doesn't count; flapping fires at most once per 20s", () => {
  assert.deepEqual(replay(seq([[0, 2, "up", "up", "main"], [2, 5, "down", "up", "main"], [5, 60, "up", "up", "main"]])), [])
  const segs: [number, number, S, S, "main"][] = [[0, 10, "up", "up", "main"]]
  for (let a = 10; a < 100; a += 8) segs.push([a, a + 2, "down", "up", "main"], [a + 2, a + 8, "up", "up", "main"])
  const t = replay(seq(segs)).map((f) => Number(f.split("@")[1]))
  assert.ok(t.length >= 2)
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 20, String(t))
})

test("noteRelayDisruption opens a quiet window", () => {
  noteRelayDisruption(1000, 8000)
  assert.ok(relayQuietUntil() >= 9000)
})

test("planned back on / manual Arm: auto re-arm of that input is skipped for 60s", async () => {
  const { plannedBackSkip, PLANNED_BACK_MS } = await import("@/lib/program-rearm")
  const p = { main: 100_000, backup: null }
  assert.deepEqual(plannedBackSkip(p, "main", 103_000), { why: "planned back on / manual arm", agoSec: 3 }) // 18:06:51 back on → 18:06:54 re-arm
  assert.equal(plannedBackSkip(p, "backup", 103_000), null) // other input not covered
  assert.equal(plannedBackSkip(p, "main", 100_000 + PLANNED_BACK_MS + 1), null)
  assert.equal(plannedBackSkip({ main: null, backup: null }, "main", 1), null)
  assert.equal(PLANNED_BACK_MS, 60_000)
})
