import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_FAILOVER, failoverStep, FRESH_MEMORY, parseFailover, type FailoverMemory, type ProgramSource, type SourceHealth } from "@/lib/program-source"

const good: SourceHealth = { ready: true, kbps: 3000, dataAgeMs: 100 }
const stalled: SourceHealth = { ready: true, kbps: 0, dataAgeMs: 5000 }
const gone: SourceHealth = { ready: false, kbps: null, dataAgeMs: null }

function run(ticks: { t: number; main: SourceHealth; backup?: SourceHealth }[], settings = { ...DEFAULT_FAILOVER, auto: true }, start: ProgramSource = "main") {
  let active = start
  let memory: FailoverMemory = FRESH_MEMORY
  const switches: { t: number; to: ProgramSource }[] = []
  for (const tick of ticks) {
    const step = failoverStep({ active, main: tick.main, backup: tick.backup ?? good, settings, memory, now: tick.t })
    memory = step.memory
    if (step.switchTo) { active = step.switchTo; switches.push({ t: tick.t, to: step.switchTo }) }
  }
  return { active, switches }
}
const series = (from: number, to: number, main: SourceHealth, backup?: SourceHealth) => Array.from({ length: (to - from) / 500 + 1 }, (_, i) => ({ t: from + i * 500, main, backup }))

test("off by default: never switches", () => {
  assert.deepEqual(run(series(0, 20000, gone), DEFAULT_FAILOVER).switches, [])
})
test("main stall > 3s → backup; healthy 10s → back to main", () => {
  const r = run([...series(0, 2000, good), ...series(2500, 8000, stalled), ...series(8500, 25000, good)])
  assert.equal(r.switches[0].to, "backup")
  assert.ok(r.switches[0].t >= 5500 && r.switches[0].t <= 6000, String(r.switches[0].t))
  assert.equal(r.switches[1].to, "main")
  assert.ok(r.switches[1].t >= 18500 && r.switches[1].t <= 19000, String(r.switches[1].t))
})
test("short blip under stallSec does not switch; no backup → stays on main", () => {
  assert.deepEqual(run([...series(0, 2000, good), ...series(2500, 4000, gone), ...series(4500, 9000, good)]).switches, [])
  assert.deepEqual(run(series(0, 10000, gone, gone)).switches, [])
})
test("autoReturn off: stays on backup; manual backup is not auto-returned", () => {
  const stay = run([...series(0, 6000, gone), ...series(6500, 30000, good)], { ...DEFAULT_FAILOVER, auto: true, autoReturn: false })
  assert.equal(stay.active, "backup")
  assert.deepEqual(run(series(0, 30000, good), { ...DEFAULT_FAILOVER, auto: true }, "backup").switches, [])
})
test("parseFailover clamps and defaults", () => {
  assert.deepEqual(parseFailover(null), DEFAULT_FAILOVER)
  assert.deepEqual(parseFailover({ auto: true, stallSec: 0.2, returnSec: 9999, autoReturn: false }), { auto: true, stallSec: 1, returnSec: 600, autoReturn: false })
})
