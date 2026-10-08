import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  escapeDrawtext,
  formatBannerDate,
  formatTimeRange,
  remainingUntil,
  splitEventTitle,
  timeZoneAbbreviation,
  wallTimeInZone,
} from "./countdown.ts"

describe("remainingUntil", () => {
  it("splits a future instant into days, hours, minutes, seconds", () => {
    const now = new Date("2026-10-07T14:00:00Z")
    const target = new Date("2026-10-09T16:05:07Z")
    const remaining = remainingUntil(target, now)
    assert.equal(remaining.done, false)
    assert.equal(remaining.days, 2)
    assert.equal(remaining.hours, 2)
    assert.equal(remaining.minutes, 5)
    assert.equal(remaining.seconds, 7)
  })

  it("matches 4 Nov 09:30 GMT from 8 Oct 2026 10:21 BST as 27d 0h 8m", () => {
    const target = wallTimeInZone("2026-11-04", "09:30", "Europe/London")
    const now = new Date("2026-10-08T09:21:05Z")
    const remaining = remainingUntil(target, now)
    assert.equal(remaining.days, 27)
    assert.equal(remaining.hours, 0)
    assert.equal(remaining.minutes, 8)
    assert.equal(remaining.seconds, 55)
  })

  it("clamps a past instant to zero", () => {
    const remaining = remainingUntil(
      new Date("2025-11-04T08:30:00Z"),
      new Date("2026-10-07T14:00:00Z"),
    )
    assert.equal(remaining.done, true)
    assert.equal(remaining.totalSeconds, 0)
  })
})

describe("banner copy", () => {
  it("formats the Hyphen site date line", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/London")
    assert.equal(formatBannerDate(date, "Europe/London"), "Wed, 04 Nov, 2026")
  })

  it("joins the session window with an en dash", () => {
    assert.equal(formatTimeRange("09:30", "16:15"), "09:30 – 16:15")
  })

  it("puts a trailing year on its own line", () => {
    assert.deepEqual(splitEventTitle("Hyphen Festival 2026"), {
      lead: "Hyphen Festival",
      year: "2026",
    })
  })
})

describe("escapeDrawtext", () => {
  it("escapes the colon in 09:30 that crashed the filtergraph", () => {
    assert.equal(
      escapeDrawtext("4 November 2026  •  09:30"),
      "4 November 2026  •  09\\:30",
    )
  })
})

describe("wallTimeInZone", () => {
  it("maps 4 November 2026 09:30 CET to unix 1793781000", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/Berlin")
    assert.equal(Math.floor(date.getTime() / 1000), 1_793_781_000)
  })

  it("maps 4 November 2026 09:30 London to unix 1793784600 (GMT)", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/London")
    assert.equal(Math.floor(date.getTime() / 1000), 1_793_784_600)
  })

  it("does not use the 2025 timestamp from the original command", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/Berlin")
    assert.notEqual(Math.floor(date.getTime() / 1000), 1_762_245_000)
  })
})

describe("timeZoneAbbreviation", () => {
  it("uses CET for Berlin in November, not a GMT+0 Intl variant", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/Berlin")
    assert.equal(timeZoneAbbreviation(date, "Europe/Berlin"), "CET")
  })

  it("uses GMT for London in November", () => {
    const date = wallTimeInZone("2026-11-04", "09:30", "Europe/London")
    assert.equal(timeZoneAbbreviation(date, "Europe/London"), "GMT")
  })
})
