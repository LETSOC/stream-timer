/**
 * Process listing without forking `ps`.
 *
 * The desk's status routes check our own processes (pidfiles, relay loops, supervisors, stray
 * publishers) every couple of seconds. `spawnSync("ps")` forks and blocks Node's event loop while
 * it runs, which stalls every other request (desk taps, deck socket) under load. On Linux the same
 * facts are in /proc and can be read directly; elsewhere (macOS) we fall back to `ps` unchanged.
 * Nothing here is cached: callers keep whatever caching they already had.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const PROC = "/proc"

/** True when a usable /proc is mounted (Linux). */
export function hasProc(procRoot = PROC): boolean {
  try {
    return fs.existsSync(path.join(procRoot, "self", "cmdline"))
  } catch {
    return false
  }
}

/** Pure: /proc/<pid>/cmdline (NUL-separated argv) as `ps -o command=` prints it. Empty = no argv (zombie / kernel thread). */
export function cmdlineToCommand(raw: string): string {
  return raw.replace(/\0+$/, "").split("\0").join(" ")
}

/** Pure: process group id and comm from /proc/<pid>/stat ("pid (comm) state ppid pgrp …"; comm may hold spaces and parens). */
export function parseProcStat(stat: string): { pgid: number; comm: string } | null {
  const open = stat.indexOf("(")
  const close = stat.lastIndexOf(")")
  if (open < 0 || close < open) return null
  const rest = stat.slice(close + 1).trim().split(/\s+/)
  const pgid = Number(rest[2])
  if (!Number.isInteger(pgid)) return null
  return { pgid, comm: stat.slice(open + 1, close) }
}

/**
 * The command line of `pid` from /proc, or null when /proc can't answer (not Linux, or the pid is
 * gone). "" means the process exists but has no argv (zombie / kernel thread).
 */
export function procCommand(pid: number, procRoot = PROC): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    return cmdlineToCommand(fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "latin1"))
  } catch {
    return null
  }
}

/** `ps -axo pid=,pgid=,command=` built from /proc; null when /proc isn't there. */
export function procList(procRoot = PROC): string | null {
  if (!hasProc(procRoot)) return null
  let names: string[]
  try {
    names = fs.readdirSync(procRoot)
  } catch {
    return null
  }
  const lines: string[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = parseProcStat(fs.readFileSync(path.join(procRoot, name, "stat"), "latin1"))
      if (!stat) continue
      const command = cmdlineToCommand(fs.readFileSync(path.join(procRoot, name, "cmdline"), "latin1"))
      // Same as ps: a process without argv shows its name in brackets.
      lines.push(`${name} ${stat.pgid} ${command || `[${stat.comm}]`}`)
    } catch {
      // exited while we were reading: skip it, like ps would
    }
  }
  return `${lines.join("\n")}\n`
}

/** All processes as "pid pgid command" lines: /proc on Linux, `ps` elsewhere. Null when neither works. */
export function listProcesses(): string | null {
  const fromProc = procList()
  if (fromProc !== null) return fromProc
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

/** The command line of one process: /proc on Linux, `ps -o command= -p` elsewhere. Null = unknown / not running. */
export function processCommand(pid: number): string | null {
  if (hasProc()) return procCommand(pid)
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  return result.status === 0 ? result.stdout : null
}
