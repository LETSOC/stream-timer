import { test } from "node:test"
import assert from "node:assert/strict"
import { initialLoadAlert, previewsPaused, stepLoadAlert, type LoadAlertState } from "./load-alert"

const run = (samples: { load: number; speed: number | null }[], everyMs = 1000, s0: LoadAlertState = initialLoadAlert()) => {
  let s = s0
  const changes: { at: number; c: string }[] = []
  samples.forEach((x, i) => { const r = stepLoadAlert(s, x, i * everyMs); s = r.state; if (r.changed) changes.push({ at: i * everyMs, c: r.changed }) })
  return { s, changes }
}
const rep = (n: number, x: { load: number; speed: number | null }) => Array.from({ length: n }, () => x)

test("load alert: only after 30s sustained, not on a short spike", () => {
  assert.equal(run(rep(25, { load: 6, speed: 1 })).s.on, false)
  const r = run(rep(31, { load: 4.5, speed: 1 }))
  assert.equal(r.s.on, true)
  assert.deepEqual(r.changes, [{ at: 30_000, c: "on" }])
  assert.match(r.s.reason, /load 4\.50 > 4/)
})

test("load alert: a dip resets the 30s clock", () => {
  const r = run([...rep(20, { load: 5, speed: 1 }), { load: 2, speed: 1 }, ...rep(20, { load: 5, speed: 1 })])
  assert.equal(r.s.on, false)
})

test("load alert: slow encoder alone triggers it; no capture (speed null) is ignored", () => {
  const r = run(rep(31, { load: 2, speed: 0.9 }))
  assert.equal(r.s.on, true)
  assert.match(r.s.reason, /encoder 0\.90x/)
  assert.equal(run(rep(40, { load: 2, speed: null })).s.on, false)
})

test("load alert: hysteresis, clears only after 30s below 3.5 and 0.98x", () => {
  const on = run(rep(31, { load: 5, speed: 1 })).s
  assert.equal(run(rep(60, { load: 3.8, speed: 1 }), 1000, on).s.on, true) // between 3.5 and 4: stays on
  assert.equal(run(rep(60, { load: 2, speed: 0.96 }), 1000, on).s.on, true) // between 0.95 and 0.98: stays on
  const off = run(rep(31, { load: 2, speed: 1 }), 1000, on)
  assert.equal(off.s.on, false)
  assert.deepEqual(off.changes.map((c) => c.c), ["off"])
})

test("previews: paused while on, unless shown anyway for this same alert", () => {
  assert.equal(previewsPaused(null, null), false)
  assert.equal(previewsPaused({ on: false, since: null }, null), false)
  assert.equal(previewsPaused({ on: true, since: 1000 }, null), true)
  assert.equal(previewsPaused({ on: true, since: 1000 }, 1000), false)
  assert.equal(previewsPaused({ on: true, since: 2000 }, 1000), true) // a new alert hides them again
})
