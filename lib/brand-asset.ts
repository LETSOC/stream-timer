/**
 * Built-in /brand images with the build as a version query: next.config serves /brand/* with ?v=
 * as immutable (a new build = a new URL), so /stream never re-asks for them after the first load.
 */
export function brandUrl(path: string): string {
  const v = process.env.APP_BUILD
  return v ? `${path}?v=${encodeURIComponent(v)}` : path
}
