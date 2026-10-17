import type { Metadata } from "next"
import { connection } from "next/server"
import { StrapOverlay } from "@/components/overlay-view"
import { overlayInitial } from "@/lib/overlay-initial"

export const metadata: Metadata = { title: "Name strap overlay" }

/** OBS browser source: 1920x1080, transparent background. View key like /stream. ?checker=1 previews on a checkerboard. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection()
  const initial = await overlayInitial(await searchParams)
  return (
    <>
      <style>{"html,body{background:transparent!important;margin:0;overflow:hidden}"}</style>
      <StrapOverlay initial={initial} />
    </>
  )
}
