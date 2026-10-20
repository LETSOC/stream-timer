import type { Metadata } from "next"
import { HolderCard } from "@/components/holder-card"

export const metadata: Metadata = { title: "Standby holder" }

/** OBS browser source or desk preview for the standby / holder cards. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Simple static render; live text comes from query or future stage state.
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black">
      <HolderCard className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]" />
    </main>
  )
}
