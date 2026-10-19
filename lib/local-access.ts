import { pickLanIp } from "@/lib/relay"

type Ifaces = Parameters<typeof pickLanIp>[0]
export type LocalAccess = { ip: string | null; port: number; base: string | null; boundToLan: boolean }

/** Pure: the http://<lan-ip>:<port> other devices on the network can open (private IPv4 preferred; loopback, docker, utun skipped). */
export function localAccess(ifaces: Ifaces, env: Record<string, string | undefined>): LocalAccess {
  const port = Number(env.PORT) || 43211
  const bind = env.BIND_HOST ?? "127.0.0.1"
  const pinned = bind !== "0.0.0.0" && bind !== "::" && !/^(127\.|localhost$|::1$)/.test(bind) ? bind : null
  const ip = pinned ?? pickLanIp(ifaces)
  return { ip, port, base: ip ? `http://${ip}:${port}` : null, boundToLan: !/^(127\.|localhost$|::1$)/.test(bind) }
}
