import assert from "node:assert/strict"
import test from "node:test"
import { socialHandle, socialSpotlight } from "@/lib/social-spotlight"

test("spotlight walks each circle for dwell, then cools down", () => {
  assert.deepEqual(socialSpotlight(0, 3, 1000, 2000), { active: 0, cooling: false, progress: 0, step: 0 })
  assert.equal(socialSpotlight(1500, 3, 1000, 2000).active, 1)
  assert.equal(socialSpotlight(1500, 3, 1000, 2000).progress, 0.5)
  assert.equal(socialSpotlight(2999, 3, 1000, 2000).active, 2)
  const cool = socialSpotlight(3500, 3, 1000, 2000)
  assert.equal(cool.active, null)
  assert.equal(cool.cooling, true)
  assert.equal(socialSpotlight(5000, 3, 1000, 2000).active, 0)
  assert.equal(socialSpotlight(5000, 3, 1000, 2000).step, 4)
  assert.equal(socialSpotlight(99_999, 1, 1000, 2000).active, 0)
  assert.equal(socialSpotlight(0, 0).active, null)
})

test("socialHandle", () => {
  assert.equal(socialHandle("https://www.x.com/hyphenfest/"), "x.com/hyphenfest")
  assert.equal(socialHandle("not a url"), "not a url")
})
