import { Suspense } from "react"
import { OperatorConsole } from "@/components/operator-console"

export default function Home() {
  return (
    <Suspense>
      <OperatorConsole />
    </Suspense>
  )
}
