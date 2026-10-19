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
  assert.deepEqual(parseFailover({ auto: true, stallSec: 0.2, returnSec: 9999, autoReturn: false }), { auto: true, stallSec: 1, returnSec: 600, autoReturn: false, switchBufferMs: 1000, returnMode: "auto", flapCount: 3, flapWindowSec: 300, flapStableSec: 60, autoRearm: true })
})

test("backup dies while on air and main is fine: back to main (auto on), not with auto off", () => {
  const settings = { auto: true, stallSec: 3, returnSec: 10, autoReturn: false, switchBufferMs: 1000, returnMode: "auto", flapCount: 3, flapWindowSec: 300, flapStableSec: 60 } as const
  const ok = { ready: true, kbps: 2000, dataAgeMs: 100 }
  const dead = { ready: false, kbps: null, dataAgeMs: null }
  let memory = FRESH_MEMORY
  let s = failoverStep({ active: "backup", main: ok, backup: dead, settings, memory, now: 0 })
  assert.equal(s.switchTo, null); memory = s.memory
  s = failoverStep({ active: "backup", main: ok, backup: dead, settings, memory, now: 3100 })
  assert.equal(s.switchTo, "main")
  assert.equal(failoverStep({ active: "backup", main: ok, backup: dead, settings: { ...settings, auto: false }, memory, now: 3100 }).switchTo, null)
  assert.equal(failoverStep({ active: "backup", main: dead, backup: dead, settings, memory, now: 3100 }).switchTo, null)
})

test("manual switch refuses an input with no signal, allows leaving a dead one", async () => {
  const { manualSwitchError, hasSignal } = await import("./program-source")
  const ok = { ready: true, kbps: 3000, dataAgeMs: 200 }
  const dead = { ready: false, kbps: null, dataAgeMs: null }
  const stale = { ready: true, kbps: 0, dataAgeMs: 9000 }
  assert.equal(hasSignal(ok), true); assert.equal(hasSignal(dead), false); assert.equal(hasSignal(stale), false)
  assert.equal(manualSwitchError({ main: ok, backup: dead }, "main", "backup"), "Backup has no signal")
  assert.equal(manualSwitchError({ main: ok, backup: stale }, "main", "backup"), "Backup has no signal")
  assert.equal(manualSwitchError({ main: dead, backup: ok }, "main", "backup"), null)
  assert.equal(manualSwitchError({ main: dead, backup: dead }, "backup", "backup"), null)
  assert.equal(manualSwitchError(null, "main", "backup"), null)
})

test("flapping guard: >3 Main failures in 5 min holds Backup until Main is stable 60s", () => {
  const s = { ...DEFAULT_FAILOVER, auto: true }
  const bad: SourceHealth = { ready: false, kbps: null, dataAgeMs: null }
  let mem: FailoverMemory = FRESH_MEMORY
  let active: ProgramSource = "main"
  let t = 0
  const run = (main: SourceHealth, secs: number) => {
    let last
    for (let i = 0; i < secs * 2; i++) {
      t += 500
      last = failoverStep({ active, main, backup: good, settings: s, memory: mem, now: t })
      mem = last.memory
      if (last.switchTo) active = last.switchTo
    }
    return last!
  }
  run(good, 2)
  for (let k = 0; k < 3; k++) { run(bad, 4); assert.equal(active, "backup"); run(good, 11); assert.equal(active, "main", `returned after fail ${k + 1}`) }
  const step = run(bad, 4) // 4th failure → flapping
  assert.equal(active, "backup"); assert.equal(mem.mainFails?.length, 4); assert.equal(step.status?.flapping, true)
  const held = run(good, 30)
  assert.equal(active, "backup", "held on Backup while flapping")
  assert.match(held.status?.holdText ?? "", /Main flapping · holding Backup \(returns after 60s stable/)
  run(good, 31)
  assert.equal(active, "main", "returns after 60s stable")
})

test("flap note logged once, failures counted once per bad spell", () => {
  const s = { ...DEFAULT_FAILOVER, auto: true, flapCount: 1 }
  const bad: SourceHealth = { ready: false, kbps: null, dataAgeMs: null }
  let mem: FailoverMemory = FRESH_MEMORY, t = 0, notes = 0
  const tick = (main: SourceHealth, active: ProgramSource) => { t += 500; const r = failoverStep({ active, main, backup: good, settings: s, memory: mem, now: t }); mem = r.memory; if (r.note) notes++; return r }
  tick(good, "backup")
  for (let i = 0; i < 20; i++) tick(bad, "backup")
  assert.equal(mem.mainFails?.length, 1)
  for (let i = 0; i < 4; i++) tick(good, "backup")
  for (let i = 0; i < 20; i++) tick(bad, "backup")
  assert.equal(mem.mainFails?.length, 2); assert.equal(notes, 1)
})

test("Ask me: never auto-returns, offers Return now once Main is ready", () => {
  const s = { ...DEFAULT_FAILOVER, auto: true, returnMode: "ask" as const }
  let mem: FailoverMemory = { ...FRESH_MEMORY, failedOver: true }, t = 0, r
  for (let i = 0; i < 200; i++) { t += 500; r = failoverStep({ active: "backup", main: good, backup: good, settings: s, memory: mem, now: t, mainReady: i > 10 }); mem = r.memory; assert.equal(r.switchTo, null) }
  assert.equal(r!.status?.askReturn, true)
  r = failoverStep({ active: "backup", main: good, backup: good, settings: s, memory: mem, now: t + 500, mainReady: false })
  assert.equal(r.status?.askReturn, false)
  assert.equal(parseFailover({ returnMode: "ask" }).returnMode, "ask"); assert.equal(parseFailover({ returnMode: "x" }).returnMode, "auto")
})

test("a Main that never started isn't counted as a failure", () => {
  const s = { ...DEFAULT_FAILOVER, auto: true }
  let mem: FailoverMemory = FRESH_MEMORY, t = 0
  for (let i = 0; i < 20; i++) { t += 500; mem = failoverStep({ active: "main", main: { ready: false, kbps: null, dataAgeMs: null }, backup: good, settings: s, memory: mem, now: t }).memory }
  assert.equal(mem.mainFails?.length, 0)
})
