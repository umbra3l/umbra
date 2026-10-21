import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { CliRenderer } from "@opentui/core"

// The TUI is a front-end only: every sandbox operation goes through the
// `umbra` CLI (bin/umbra), which owns the VM, jail, egress proxy and
// snapshots. bin/umbra passes its own path and version in when it starts us.
export const UMBRA_BIN = process.env.UMBRA_BIN || `${homedir()}/.config/umbra/bin/umbra`
export const UMBRA_VERSION = process.env.UMBRA_VERSION || "2.1.0"
export const EGRESS_LOG = process.env.UMBRA_EGRESS_LOG || `${homedir()}/.local/share/umbra/logs/egress.log`
export const REDUCED_MOTION = process.env.UMBRA_REDUCED_MOTION === "1" || process.env.NO_MOTION === "1"

export interface ToolStatus {
  key: string
  name: string
  installed: boolean
  version: string
  net: string
  exclusive: boolean
  live: number
  vcpus: number
  ram: number
}

export interface Status {
  version: string
  net: string
  cwd: string
  workspace: { root: string | null; mounted: boolean; reason: string | null; start: string | null; branch: string | null }
  snapshots: { count: number; latest: string | null; ageSeconds: number | null }
  lastSession: { changed: number; added: number; modified: number; deleted: number; risky: string[] } | null
  egressToday: { allowed: number; refused: number }
  tools: ToolStatus[]
}

export async function fetchStatus(): Promise<Status | null> {
  try {
    const proc = Bun.spawn({ cmd: [UMBRA_BIN, "status", "--json"], stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return JSON.parse(text) as Status
  } catch {
    return null
  }
}

// libkrun leaves the shared terminal O_NONBLOCK; bin/umbra resets it, and
// this makes sure before the TUI repaints (torn writes garble the screen).
export function restoreBlockingStdio(): void {
  Bun.spawnSync({
    cmd: [
      "python3",
      "-I",
      "-c",
      "import fcntl,os\nfor fd in (0,1,2):\n  try: fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) & ~os.O_NONBLOCK)\n  except OSError: pass",
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
}

/**
 * Hands the terminal to `umbra <args>` (a tool in its VM, a shell, the
 * sign-in flow, an undo prompt) and takes it back afterwards. The VM, jail
 * and helpers all die with that process, so a closed terminal leaves nothing.
 */
export async function runInteractive(renderer: CliRenderer, args: string[]): Promise<number> {
  renderer.suspend()
  let code = 0
  try {
    const proc = Bun.spawn({ cmd: [UMBRA_BIN, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    code = await proc.exited
    restoreBlockingStdio()
    // The TUI shows the session summary itself; only pause to leave an
    // error, or undo's confirmation result, readable.
    if (code !== 0 && code !== 130 && code !== 143) await Bun.sleep(2400)
    else if (args[0] === "undo") await Bun.sleep(1100)
  } finally {
    renderer.resume()
    renderer.requestLive()
  }
  return code
}

export interface Stream {
  done: Promise<number>
  kill(): void
}

/** Runs `umbra <args>` and feeds its output, ANSI stripped, line by line. */
export function stream(args: string[], onLine: (line: string) => void): Stream {
  const proc = Bun.spawn({ cmd: [UMBRA_BIN, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder()
    let carry = ""
    for await (const chunk of s) {
      carry += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = carry.indexOf("\n")) >= 0) {
        onLine(carry.slice(0, nl).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, ""))
        carry = carry.slice(nl + 1)
      }
    }
    if (carry) onLine(carry.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))
  }
  const done = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => proc.exited)
  return { done, kill: () => proc.kill() }
}

export interface EgressEntry {
  time: string
  tool: string
  verdict: string
  target: string
  reason: string
}

export function readEgressLog(max = 600): EgressEntry[] {
  if (!existsSync(EGRESS_LOG)) return []
  const lines = readFileSync(EGRESS_LOG, "utf8").trimEnd().split("\n").slice(-max).reverse()
  const out: EgressEntry[] = []
  for (const l of lines) {
    const m = /^(\S+)\s+(\S+)\s+(ALLOW|DENY|FAIL)\s+(\S+)\s+\((.*)\)\s*$/.exec(l)
    if (m) out.push({ time: m[1]!, tool: m[2]!, verdict: m[3]!, target: m[4]!, reason: m[5]! })
  }
  return out
}

export function shortPath(p: string): string {
  const home = homedir()
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p
}

/** Shortens a path in the middle, keeping its last segments: ~/…/scratchpad/proj */
export function elide(p: string, max: number): string {
  if (p.length <= max) return p
  const parts = p.split("/")
  const head = parts[0] === "~" ? "~" : ""
  let tail = parts[parts.length - 1] ?? p
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}/${tail}`
    if (head.length + 3 + next.length > max) break
    tail = next
  }
  const out = `${head ? head + "/" : ""}…/${tail}`
  return out.length <= max ? out : `…${p.slice(p.length - max + 1)}`
}

export function age(seconds: number | null): string {
  if (seconds == null) return ""
  if (seconds < 90) return "just now"
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} days ago`
}
