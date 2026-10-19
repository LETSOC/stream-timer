import type { Metadata } from "next"
import { TimecodeOverlay } from "@/components/timecode-overlay"

export const metadata: Metadata = { title: "OBS SRC timecode (TC1)" }

/**
 * TC1: transparent 1920x1080 OBS browser source with a labelled wall-clock HH:MM:SS:FF.
 * ?fps=25|30|50|60 (default 30), ?pos=bottom-right|bottom-left|top-left|top-right (default bottom-right), ?checker=1.
 * Shows only the time of day (no event data), so it needs no view key.
 */
export default function Page() {
  return (
    <>
      <style>{"html,body{background:transparent!important;margin:0;overflow:hidden}"}</style>
      <TimecodeOverlay />
    </>
  )
}
