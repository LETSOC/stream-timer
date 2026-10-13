import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_STAGE, parseStage, stageScreen } from "@/lib/stage"
import { dirtySections, pickSection, savePayloadStage, sectionDirty, withSection, type DeskSnapshot } from "@/lib/desk-sections"
import { saveUpload, sniffImage } from "@/lib/uploads"

const base: DeskSnapshot = { event: { ...DEFAULT_EVENT }, stage: { ...DEFAULT_STAGE } }

test("dirty is per section", () => {
  const draft: DeskSnapshot = { event: { ...base.event, name: "New" }, stage: { ...base.stage, endTitle: "Bye" } }
  assert.deepEqual(dirtySections(draft, base), ["event", "endCard"])
  assert.equal(sectionDirty("look", draft, base), false)
  assert.deepEqual(dirtySections(draft, null), [])
})

test("saving one section publishes only that section", () => {
  const draft: DeskSnapshot = { event: { ...base.event, name: "New", xUrl: "https://x.com/new" }, stage: { ...base.stage, checker: 9 } }
  const next = withSection("event", base, draft)
  assert.equal(next.event.name, "New")
  assert.equal(next.event.xUrl, base.event.xUrl) // socials still a draft
  assert.equal(next.stage.checker, base.stage.checker) // look still a draft
  assert.deepEqual(dirtySections(draft, next), ["look", "socials"])
})

test("revert after a failed save puts the old values back for that section only", () => {
  const draft: DeskSnapshot = { ...base, stage: { ...base.stage, breakTitle: "Back soon" } }
  const optimistic = withSection("breakCard", base, draft)
  const reverted = withSection("breakCard", optimistic, base)
  assert.equal(reverted.stage.breakTitle, DEFAULT_STAGE.breakTitle)
  assert.deepEqual(dirtySections(draft, reverted), ["breakCard"])
})

test("autosave sends published sections + live switches from the desk, never drafts", () => {
  const draft: DeskSnapshot = { ...base, stage: { ...base.stage, endTitle: "DRAFT", overlay: "break", overlayAt: 5, forceEnd: false } }
  const stage = savePayloadStage(base, draft)
  assert.equal(stage.endTitle, DEFAULT_STAGE.endTitle)
  assert.equal(stage.overlay, "break")
  assert.equal(stage.overlayAt, 5)
  assert.deepEqual(Object.keys(pickSection("speakers", base).stage ?? {}), ["speakers", "gallerySeconds", "galleryPause", "galleryOffset", "galleryScale"])
})

test("screen precedence: break/hold > end card > countdown", () => {
  assert.equal(stageScreen({ overlay: "break", forceEnd: true, holdCountdown: false }, true), "break")
  assert.equal(stageScreen({ overlay: "hold", forceEnd: false, holdCountdown: false }, false), "hold")
  assert.equal(stageScreen({ overlay: "none", forceEnd: true, holdCountdown: false }, false), "end")
  assert.equal(stageScreen({ overlay: "none", forceEnd: false, holdCountdown: false }, true), "end")
  assert.equal(stageScreen({ overlay: "none", forceEnd: false, holdCountdown: true }, true), "countdown")
})

test("overlay stage fields parse safely", () => {
  const s = parseStage({ overlay: "evil", breakFit: "stretch", breakImage: "javascript:alert(1)", holdImage: "/uploads/abc.png", overlayAt: "x" })
  assert.equal(s.overlay, "none")
  assert.equal(s.breakFit, "cover")
  assert.equal(s.breakImage, "")
  assert.equal(s.holdImage, "/uploads/abc.png")
  assert.equal(s.overlayAt, null)
  assert.equal(parseStage({}).breakTitle, "We'll be right back")
})

test("uploads: magic-byte check, size cap, content-addressed name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-"))
  process.env.STREAM_DATA_DIR = dir
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  assert.equal(sniffImage(png), "png")
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>")), null)
  const saved = saveUpload(png)
  assert.ok(saved.ok && /^\/uploads\/[a-f0-9]{32}\.png$/.test(saved.url))
  const again = saveUpload(png)
  assert.ok(saved.ok && again.ok && saved.url === again.url)
  const bad = saveUpload(new TextEncoder().encode("hello"))
  assert.ok(!bad.ok && bad.status === 415)
  const big = saveUpload(new Uint8Array(5_000_001))
  assert.ok(!big.ok && big.status === 413)
})

test("welcome back card: parsed, defaulted, beats end card", () => {
  const s = parseStage({ overlay: "welcome", welcomeFit: "contain", welcomeImage: "javascript:x" })
  assert.equal(s.overlay, "welcome")
  assert.equal(s.welcomeTitle, "Welcome back")
  assert.equal(s.welcomeFit, "contain")
  assert.equal(s.welcomeImage, "")
  assert.equal(stageScreen({ overlay: "welcome", forceEnd: true, holdCountdown: false }, true), "welcome")
})

test("planRemoteSync: clean sections follow the server, dirty ones conflict", async () => {
  const { planRemoteSync } = await import("@/lib/desk-sections")
  const published: DeskSnapshot = { event: { ...DEFAULT_EVENT }, stage: { ...DEFAULT_STAGE } }
  const remote: DeskSnapshot = { event: { ...DEFAULT_EVENT, name: "Remote name" }, stage: { ...DEFAULT_STAGE, breakTitle: "Remote break", endTitle: "Remote end" } }
  const draft: DeskSnapshot = { event: { ...DEFAULT_EVENT }, stage: { ...DEFAULT_STAGE, breakTitle: "My break", endTitle: "Remote end" } }
  const plan = planRemoteSync(draft, published, remote)
  assert.deepEqual(plan.conflicts, ["breakCard"])
  assert.ok(plan.take.includes("event"))
  assert.ok(plan.take.includes("endCard"), "my draft already equals theirs")
  assert.ok(!plan.take.includes("look"))
})

test("server save with identical content keeps rev (no ping-pong between synced desks)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-sync-"))
  process.env.STREAM_DATA_DIR = dir
  const es = await import("@/lib/event-server")
  const first = es.writeServerEvent({ ...DEFAULT_EVENT }, null, null, {}, undefined)!
  const again = es.writeServerEvent({ ...DEFAULT_EVENT }, null, null, {}, first.rev - 5)!
  assert.equal(again.rev, first.rev)
})
