/** Terminal log lines for the program inputs: "14:02:07 [program] …" (local time). */
export function logTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
export function programLine(msg: string, d = new Date()): string {
  return `${logTime(d)} [program] ${msg}`
}
export function plog(msg: string) {
  console.log(programLine(msg))
}
export const PROGRAM_LOG_VERBOSE = () => process.env.PROGRAM_LOG === "verbose"

/** Log-on-change: returns the message only when `key` differs from the last one for `slot`. */
export function changeLogger() {
  const last = new Map<string, string>()
  return (slot: string, key: string, msg: string): string | null => {
    if (last.get(slot) === key) return null
    const first = !last.has(slot)
    last.set(slot, key)
    return first && (key === "" || key === "off" || key === "0") ? null : msg
  }
}
