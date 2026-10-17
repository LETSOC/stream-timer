import type { Metadata } from "next"
import { TimecodeOverlay } from "@/components/timecode-overlay"

export const metadata: Metadata = { title: "BACKUP SRC timecode (TC1, OBS computer 2)" }

/** Same as /overlay/timecode?src=backup: label BACKUP SRC, bottom-left, amber, beep 1.2 kHz / 2.4 kHz on the minute. */
export default function Page() {
  return (
    <>
      <style>{"html,body{background:transparent!important;margin:0;overflow:hidden}"}</style>
      <TimecodeOverlay src="backup" />
    </>
  )
}
