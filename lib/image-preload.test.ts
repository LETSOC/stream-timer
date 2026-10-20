import assert from "node:assert/strict"
import test from "node:test"
import { imageReady, preloadImage, stageImageUrls, waitForImage } from "./image-preload"
import { brandUrl } from "./brand-asset"

const base = { logoUrl: "", speakers: [] as { image: string }[], breakImage: "", holdImage: "", welcomeImage: "" }

test("stageImageUrls: every card, the logo (or the brand fallback), speakers and brand QRs, once each", () => {
  const urls = stageImageUrls({ ...base, logoUrl: "/uploads/aa.png", breakImage: "/uploads/bb.jpg", holdImage: "/uploads/bb.jpg", welcomeImage: "https://cdn.example.com/w.webp", speakers: [{ image: "/uploads/s1.png" }, { image: "" }, { image: "javascript:alert(1)" }] }, (p) => `${p}?v=7`)
  assert.deepEqual(urls, ["/uploads/aa.png", "/brand/rsvp-qr.png?v=7", "/brand/end-qr.png?v=7", "/uploads/bb.jpg", "https://cdn.example.com/w.webp", "/uploads/s1.png"])
  assert.equal(stageImageUrls(base)[0], "/brand/hyphen-emerald.png")
})

test("no DOM (server render): preload is a no-op, waits time out instead of hanging", async () => {
  assert.equal(imageReady(""), true)
  assert.equal(imageReady("/uploads/x.png"), false)
  await preloadImage("/uploads/x.png")
  const t = Date.now()
  await waitForImage("/uploads/never.png", 50)
  assert.ok(Date.now() - t < 1000)
})

test("brandUrl versions built-in images with the build", () => {
  const old = process.env.APP_BUILD
  process.env.APP_BUILD = "123"
  assert.equal(brandUrl("/brand/end-qr.png"), "/brand/end-qr.png?v=123")
  delete process.env.APP_BUILD
  assert.equal(brandUrl("/brand/end-qr.png"), "/brand/end-qr.png")
  if (old !== undefined) process.env.APP_BUILD = old
})
