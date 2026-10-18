import test from "node:test"
import assert from "node:assert/strict"
import { FRESH_REARM, rearmStep, type RearmMemory } from "@/lib/program-rearm"

type Tick = [t: number, s: "up" | "down" | "notready"]
function run(ticks: Tick[], enabled = true) {
  let mem: RearmMemory = FRESH_REARM
  const fired: number[] = []
  for (const [t, s] of ticks) {
    const r = rearmStep(mem, { down: s === "down", ready: s === "up", now: t, enabled })
    mem = r.mem
    if (r.fire) fired.push(t)
  }
  return fired
}
const span = (a: number, b: number, s: Tick[1]): Tick[] => { const out: Tick[] = []; for (let t = a; t <= b; t += 500) out.push([t, s]); return out }

test("re-arms once, after 3s of stable READY following a drop", () => {
  assert.deepEqual(run([...span(0, 5000, "up"), ...span(5500, 9000, "down"), ...span(9500, 20000, "up")]), [12500])
  assert.deepEqual(run(span(0, 60000, "up")), []) // never dropped
  assert.deepEqual(run([...span(0, 5000, "down"), ...span(5500, 20000, "up")], false), []) // toggle off
})

test("not READY yet (e.g. no audio) waits; a short blip before settle restarts the 3s", () => {
  assert.deepEqual(run([...span(0, 2000, "down"), ...span(2500, 6000, "notready"), ...span(6500, 7500, "up"), [8000, "down"], ...span(8500, 15000, "up")]), [11500])
})

test("our own disarm kick doesn't re-trigger; flapping fires at most once per 20s", () => {
  // drop → re-arm at 6.5s → self-kick drop → back: no second re-arm.
  assert.deepEqual(run([...span(0, 3000, "down"), ...span(3500, 7000, "up"), ...span(7500, 10000, "down"), ...span(10500, 40000, "up")]), [6500])
  // Real drops every few seconds after the self window cleared: spaced ≥20s.
  const ticks: Tick[] = [...span(0, 1000, "down"), ...span(1500, 6000, "up")]
  for (let t = 6500; t < 80000; t += 8000) ticks.push(...span(t, t + 1000, "down"), ...span(t + 1500, t + 7500, "up"))
  const fired = run(ticks)
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] >= 20000, String(fired))
})
