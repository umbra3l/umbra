import {
  createCliRenderer,
  Renderable,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import { DotCanvas } from "./canvas"
import { mix, rgba, type RGB } from "./color"
import { Nebula } from "./nebula"
import { expoOut, Orrery, type Label } from "./orrery"
import { buildTheme, detectTheme, type Theme } from "./theme"
import { drawWord, fitWord } from "./type"
import * as umbra from "./umbra"

const TOOLS = ["claude", "opencode", "agy"] as const
type ToolKey = (typeof TOOLS)[number]
const NAMES: Record<ToolKey, string> = { claude: "Claude Code", opencode: "OpenCode", agy: "Antigravity" }

type ActionId = "launch" | "shell" | "login" | "diff" | "undo" | "egress" | "audit" | "refresh"
interface Action {
  id: ActionId
  key: string
  label: string
  hint: string
  disabled?: boolean
  args?: string[]
}

type Rect = { x: number; y: number; w: number; h: number }
interface Layout {
  mode: "wide" | "stack" | "tiny"
  W: number
  H: number
  top: number
  bottom: number
  orrery: Rect | null
  text: Rect
}

interface ReaderLine {
  spans: { text: string; ink: "fg" | "dim" | "ok" | "warn" | "danger" | "tool" | "halo"; bold?: boolean }[]
}

interface Reader {
  title: string
  lines: ReaderLine[]
  scroll: number
  running: boolean
  stream?: umbra.Stream
  empty: string
}

function actionsFor(tool: ToolKey, st: umbra.Status | null): Action[] {
  const ts = st?.tools.find((t) => t.key === tool)
  const installed = ts?.installed ?? true
  const ws = st?.workspace
  const snap = st?.snapshots
  const last = st?.lastSession
  const here = ws?.mounted ? `in ${umbra.elide(umbra.shortPath(ws.start ?? ws.root ?? ""), 44)}` : "no project here · sandbox home"
  const locked = !!ts?.exclusive && (ts?.live ?? 0) > 0
  const list: Action[] = [
    locked
      ? { id: "launch", key: "⏎", label: "Launch throwaway", hint: "already running · this session's state is discarded", args: ["run", "--ephemeral", tool] }
      : { id: "launch", key: "⏎", label: "Launch", hint: here, args: ["run", tool] },
    { id: "shell", key: "s", label: "Shell", hint: "bash inside this VM", args: ["shell", tool] },
    { id: "login", key: "i", label: "Sign in", hint: tool === "opencode" ? "opencode auth login" : "browser sign-in", args: ["login", tool] },
    {
      id: "diff",
      key: "d",
      label: "Last session's changes",
      hint: !snap?.count ? "no snapshot yet" : last ? (last.changed ? `${last.changed} files` : "nothing changed") : "",
      disabled: !snap?.count,
    },
    {
      id: "undo",
      key: "u",
      label: "Undo last session",
      hint: snap?.count ? `back to ${umbra.age(snap.ageSeconds)}` : "no snapshot yet",
      disabled: !snap?.count,
      args: ["undo"],
    },
    {
      id: "egress",
      key: "e",
      label: "Egress log",
      hint: st ? `${st.egressToday.allowed} allowed · ${st.egressToday.refused} refused today` : "",
    },
    { id: "audit", key: "a", label: "Security audit", hint: "about 15 s · leaves nothing behind" },
  ]
  if (tool === "opencode") list.push({ id: "refresh", key: "r", label: "Refresh models", hint: "models.dev", args: ["exec", tool, "opencode", "models", "--refresh"] })
  if (!installed) for (const a of list) if (a.id !== "egress") ((a.disabled = true), (a.hint = "not installed"))
  return list
}

function computeLayout(W: number, H: number): Layout {
  const top = H >= 32 ? 1 : 0
  const bottom = H >= 32 ? H - 2 : H - 1
  if (W < 64 || H < 20) return { mode: "tiny", W, H, top, bottom, orrery: null, text: { x: 2, y: top + 3, w: W - 4, h: bottom - top - 4 } }
  if (W >= 118 && W / H >= 1.85) {
    const ow = Math.round(W * 0.52)
    return {
      mode: "wide",
      W,
      H,
      top,
      bottom,
      orrery: { x: 2, y: top + 2, w: ow - 2, h: bottom - top - 3 },
      text: { x: ow + 4, y: top + 3, w: W - ow - 7, h: bottom - top - 5 },
    }
  }
  // The text needs ~15 rows (name, facts, 7-8 actions); the orrery gets the
  // rest up to 44% of the height, and below 9 rows it collapses to a strip.
  const oh = Math.min(30, Math.round(H * 0.44), bottom - top - 4 - 15)
  if (oh < 9) return { mode: "tiny", W, H, top, bottom, orrery: null, text: { x: 2, y: top + 3, w: W - 4, h: bottom - top - 4 } }
  return {
    mode: "stack",
    W,
    H,
    top,
    bottom,
    orrery: { x: 2, y: top + 2, w: W - 4, h: oh },
    text: { x: 4, y: top + 3 + oh, w: W - 8, h: bottom - top - oh - 4 },
  }
}

// The whole screen, drawn during the render pass itself. A FrameBuffer would
// be resized only after the frame callback ran, so every resize showed one
// stale (black) frame; here `buffer` is always the terminal's current size.
class Scene extends Renderable {
  constructor(
    ctx: RenderContext,
    private paint: (buf: OptimizedBuffer) => void,
  ) {
    super(ctx, { id: "umbra", width: "100%", height: "100%" })
  }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.paint(buffer)
  }
}

/** `injected` lets tools/preview.ts drive the real UI in a headless renderer. */
export async function main(injected?: CliRenderer): Promise<void> {
  // A short resize debounce: the default 100 ms leaves the terminal blank
  // for the whole drag, since nothing redraws until the size settles.
  const renderer: CliRenderer = injected ?? await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, useMouse: true, debounceDelay: 16 })
  let theme: Theme = await detectTheme(renderer).catch(() => buildTheme())
  renderer.setBackgroundColor(rgba(theme.bg))
  renderer.on("palette", async () => {
    // The wallpaper changed (quickshell re-applied the palette): follow it.
    try {
      theme = await detectTheme(renderer)
      renderer.setBackgroundColor(rgba(theme.bg))
    } catch {}
  })

  const fb = new Scene(renderer, (buf) => draw(buf))
  renderer.root.add(fb)

  const cwd = process.cwd()
  const orrery = new Orrery(TOOLS.length, umbra.REDUCED_MOTION)
  const canvas = new DotCanvas()
  const nebula = new Nebula(umbra.REDUCED_MOTION)
  let status: umbra.Status | null = null
  let tool = 0
  let action = 0
  let pillY = 0
  let busy = false
  let reader: Reader | null = null
  let readerT = 0 // 0 main .. 1 reader, eased
  let nameT = 1
  let prevTool = -1
  let lastFade = 1
  let labels: Label[] = []
  let flash = false
  let lastDelay = 0
  let actionRows: { y: number; x0: number; x1: number; idx: number }[] = []
  const reduced = umbra.REDUCED_MOTION

  const refresh = async (fadeLast = false) => {
    const s = await umbra.fetchStatus()
    if (s) {
      status = s
      if (fadeLast) lastFade = reduced ? 1 : 0
    }
  }
  void refresh()
  const poll = setInterval(() => {
    if (!busy) void refresh()
  }, 12000)

  const toolKey = (): ToolKey => TOOLS[tool]!
  const actions = () => actionsFor(toolKey(), status)
  const ink = (key: string = toolKey()): RGB => theme.tool[key] ?? theme.fg

  const selectTool = (i: number) => {
    const n = ((i % TOOLS.length) + TOOLS.length) % TOOLS.length
    if (n === tool) return
    prevTool = tool
    tool = n
    nameT = reduced ? 1 : 0
    orrery.select(n)
    action = Math.min(action, actions().length - 1)
  }

  // ---------------------------------------------------------- actions --
  const openReader = (title: string, empty: string): Reader => {
    reader?.stream?.kill()
    reader = { title, lines: [], scroll: 0, running: false, empty }
    if (reduced) readerT = 1
    return reader
  }
  const closeReader = () => {
    reader?.stream?.kill()
    orrery.setScanning(false)
    reader = null
  }

  const run = async (a: Action) => {
    if (a.disabled || busy) return
    if (a.id === "egress") {
      const r = openReader("Egress log", "No egress decisions logged yet.")
      let prev = ""
      for (const e of umbra.readEgressLog()) {
        const t = e.time.replace(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d).*/, "$1-$2 $3")
        // Time and tool print once per run of identical values; the verdict
        // and host are the column you scan.
        const head = `${t}  ${e.tool.padEnd(9)}`
        const shown = head === prev ? " ".repeat(head.length) : head
        prev = head
        r.lines.push({
          spans: [
            { text: shown, ink: "dim" },
            { text: `${e.verdict.padEnd(6)}`, ink: e.verdict === "ALLOW" ? "ok" : e.verdict === "DENY" ? "danger" : "warn", bold: true },
            { text: e.target, ink: "fg" },
            { text: `  ${e.reason}`, ink: "dim" },
          ],
        })
      }
      return
    }
    if (a.id === "diff" || a.id === "audit") {
      const r = openReader(a.id === "diff" ? "Last session's changes" : "Security audit", a.id === "diff" ? "Nothing changed since the snapshot." : "")
      r.running = true
      if (a.id === "audit") orrery.setScanning(true)
      const args = a.id === "diff" ? ["diff", cwd] : ["audit", toolKey()]
      r.stream = umbra.stream(args, (line) => {
        if (reader !== r) return
        const l = line.trimEnd()
        if (!l.trim()) return
        r.lines.push(styleLine(l, a.id))
      })
      void r.stream.done.then(() => {
        r.running = false
        if (reader === r) orrery.setScanning(false)
      })
      return
    }
    if (!a.args) return
    busy = true
    try {
      if (!reduced) {
        // Present at least one frame of the flash: lift the loop to 60 fps,
        // ask for a render, and hold ~2 frames before handing off.
        flash = true
        renderer.targetFps = fps = 60
        renderer.requestRender()
        await Bun.sleep(40)
        flash = false
      }
      await umbra.runInteractive(renderer, a.args)
      // Everything that handed the terminal to a VM comes back out of the shadow.
      if (a.id !== "refresh") orrery.emergeFromShadow()
      // The summary arrives with the body: held for the first ~35% of the emergence.
      lastFade = reduced ? 1 : 0
      lastDelay = reduced ? 0 : 0.3
      await refresh()
    } finally {
      busy = false
    }
  }

  const styleLine = (l: string, kind: ActionId): ReaderLine => {
    if (kind === "diff") {
      const m = /^([AMDX]) (.*?)(  !)?$/.exec(l)
      if (m) {
        const tag = m[1]!
        return {
          spans: [
            { text: `${tag}  `, ink: tag === "A" ? "ok" : tag === "D" ? "danger" : tag === "X" ? "warn" : "fg", bold: true },
            { text: m[2]!, ink: m[3] ? "warn" : "fg" },
            ...(m[3] ? [{ text: "  host-executed", ink: "warn" as const }] : []),
          ],
        }
      }
      return { spans: [{ text: l, ink: "dim" }] }
    }
    const pass = /^\s*PASS\s+(.*)$/.exec(l)
    if (pass) return { spans: [{ text: "pass  ", ink: "ok", bold: true }, { text: pass[1]!, ink: "fg" }] }
    const fail = /^\s*FAIL\s+(.*)$/.exec(l)
    if (fail) return { spans: [{ text: "fail  ", ink: "danger", bold: true }, { text: fail[1]!, ink: "fg" }] }
    if (/^audit:/.test(l)) return { spans: [{ text: l.replace(/^audit: /, ""), ink: /FAILED/.test(l) ? "danger" : "ok", bold: true }] }
    if (/side --/.test(l)) return { spans: [{ text: l.replace(/ --.*$/, ""), ink: "halo", bold: true }] }
    return { spans: [{ text: l.replace(/^\s+/, "      "), ink: "dim" }] }
  }

  // ------------------------------------------------------------ input --
  const quit = () => {
    clearInterval(poll)
    reader?.stream?.kill()
    renderer.destroy()
    process.exit(0)
  }

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (busy) return
    const name = key.name
    if (key.ctrl && name === "c") return quit()
    if (reader) {
      const page = Math.max(3, (lastLayout?.text.h ?? 20) - 8)
      if (name === "escape" || name === "q" || name === "backspace" || name === "left" || name === "h") closeReader()
      else if (name === "down" || name === "j") reader.scroll++
      else if (name === "up" || name === "k") reader.scroll--
      else if (name === "pagedown" || name === "space") reader.scroll += page
      else if (name === "pageup") reader.scroll -= page
      else if (name === "home" || name === "g") reader.scroll = 0
      else if (name === "end" || (name === "g" && key.shift)) reader.scroll = 1e9
      return
    }
    const list = actions()
    if (name === "q" || name === "escape") return quit()
    if (name === "right" || name === "l" || (name === "tab" && !key.shift)) return selectTool(tool + 1)
    if (name === "left" || name === "h" || (name === "tab" && key.shift)) return selectTool(tool - 1)
    if (name === "1" || name === "2" || name === "3") return selectTool(Number(name) - 1)
    if (name === "down" || name === "j") return void (action = (action + 1) % list.length)
    if (name === "up" || name === "k") return void (action = (action - 1 + list.length) % list.length)
    if (name === "return" || name === "enter") {
      const a = list[action]!
      return void run(a)
    }
    const hit = list.findIndex((a) => a.key === name)
    if (hit >= 0) {
      action = hit
      void run(list[hit]!)
    }
  })

  // The pointer stirs the nebula: hover swirls it, a click sends a shockwave.
  fb.onMouseMove = (e) => nebula.hover(e.x, e.y)
  fb.onMouseDrag = (e) => nebula.hover(e.x, e.y)
  fb.onMouseDown = (e) => {
    if (busy) return
    nebula.pulse(e.x, e.y)
    if (reader) return
    const row = actionRows.find((r) => r.y === e.y && e.x >= r.x0 - 1 && e.x <= r.x1)
    if (row) {
      action = row.idx
      void run(actions()[row.idx]!)
      return
    }
    const L = lastLayout
    if (L?.orrery) {
      const i = orrery.hit(labels, e.x - L.orrery.x, e.y - L.orrery.y)
      if (i >= 0) selectTool(i)
    }
  }
  fb.onMouseScroll = (e) => {
    if (reader && e.scroll) reader.scroll += e.scroll.direction === "down" ? 3 : e.scroll.direction === "up" ? -3 : 0
  }

  // ----------------------------------------------------------- render --
  // A braille dot's height over its width, from the terminal's real pixel
  // size: cells are rarely exactly 1:2 (JetBrains Mono in kitty is ~1:2.28),
  // and drawing as if they were turns the core into an upright oval. Falls
  // back to 1 when the terminal doesn't report its size; quantised so a
  // pixel of window padding doesn't make the orrery shimmer.
  const dotAspect = (): number => {
    const res = renderer.resolution
    if (!res || !res.width || !res.height) return 1
    const a = res.height / renderer.height / (res.width / renderer.width) / 2
    return a > 0.8 && a < 1.4 ? Math.round(a * 50) / 50 : 1
  }

  let lastLayout: Layout | null = null
  let last = performance.now()
  let fps = 60

  const text = (buf: OptimizedBuffer, s: string, x: number, y: number, fg: RGB, bg: RGB = theme.bg, attr = 0, maxW = Infinity) => {
    if (y < 0 || y >= buf.height || maxW <= 0) return 0
    const t = s.length > maxW ? s.slice(0, Math.max(0, maxW - 1)) + "…" : s
    buf.drawText(t, x, y, rgba(fg), rgba(bg), attr)
    return t.length
  }

  const tick = async () => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    nebula.update(dt)
    orrery.update(dt)
    if (nameT < 1) nameT = Math.min(1, nameT + dt / 0.32)
    if (lastDelay > 0) lastDelay = Math.max(0, lastDelay - dt)
    else if (lastFade < 1) lastFade = Math.min(1, lastFade + dt / 0.6)
    const target = reader ? 1 : 0
    readerT += (target - readerT) * (reduced ? 1 : 1 - Math.exp(-dt * 14))
    if (Math.abs(target - readerT) < 0.002) readerT = target
    pillY += (action - pillY) * (reduced ? 1 : 1 - Math.exp(-dt * 26))
    if (Math.abs(action - pillY) < 0.02) pillY = action

    const animating = flash || nebula.stirring || orrery.animating || nameT < 1 || lastFade < 1 || readerT !== target || pillY !== action || !!reader?.running
    const want = reduced ? 12 : animating ? 60 : 20
    if (want !== fps) {
      fps = want
      renderer.targetFps = want
    }
  }
  renderer.setFrameCallback(tick)
  renderer.requestLive()

  const draw = (buf: OptimizedBuffer) => {
    const W = buf.width
    const H = buf.height
    const L = computeLayout(W, H)
    lastLayout = L
    const bg = theme.bg
    buf.clear(rgba(bg))
    const t = toolKey()
    const ts = status?.tools.find((x) => x.key === t)
    const net = ts?.net ?? status?.net ?? "ask"
    const recede = expoOut(readerT)
    let core: { x: number; y: number; r: number } | undefined


    // Header: the mark, then this tool's sandbox at a glance.
    text(buf, "●", 2, L.top, ink())
    text(buf, "umbra", 4, L.top, theme.fg, bg, TextAttributes.BOLD)
    text(buf, `v${umbra.UMBRA_VERSION.split(".").slice(0, 2).join(".")}`, 10, L.top, theme.dim)
    if (W >= 52) {
      const right = ts ? `${ts.vcpus || 8} vCPU · ${Math.round((ts.ram || 8192) / 1024)} GiB` : ""
      const egressLabel = `egress ${net}`
      const rx = W - 3 - right.length - (right ? 5 : 0) - egressLabel.length
      text(buf, "egress ", rx, L.top, theme.dim)
      text(buf, net, rx + 7, L.top, theme.halo, bg, TextAttributes.BOLD)
      if (right) text(buf, `  ·  ${right}`, rx + egressLabel.length, L.top, theme.dim)
    }

    // The orrery.
    if (L.orrery) {
      const o = L.orrery
      canvas.resize(o.w, o.h)
      canvas.aspect = dotAspect()
      canvas.clear()
      const states = TOOLS.map((k) => {
        const s = status?.tools.find((x) => x.key === k)
        return { key: k, installed: s?.installed ?? true, live: s?.live ?? 0 }
      })
      labels = orrery.draw(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, theme, states, net, recede)
      canvas.blit(buf, o.x, o.y, bg)
      const c = orrery.core
      core = { x: o.x + c.x / 2, y: o.y + c.y / (4 * canvas.aspect), r: c.r / 2 }
      for (const l of labels) {
        const lx = o.x + l.x
        const ly = o.y + l.y
        if (ly < o.y || ly >= o.y + o.h || lx >= o.x + o.w - 2) continue
        const name = (l.installed ? l.key : `${l.key} · not installed`) + (l.live > 0 ? `  ${l.live} live` : "")
        const c = mix(l.selected ? ink(l.key) : theme.dim, bg, recede * 0.6)
        const room = o.x + o.w - lx
        for (let k = 0; k < Math.min(name.length, room); k++) {
          const under = canvas.cellColor(l.x + k, l.y) ?? bg
          buf.drawText(name[k]!, lx + k, ly, rgba(c), rgba(under), l.selected && k < l.key.length ? TextAttributes.BOLD : 0)
        }
      }
      // Registration ticks instead of a box.
      const hair = theme.hair
      text(buf, "┌─", o.x - 1, o.y - 1, hair)
      text(buf, "─┐", o.x + o.w - 1, o.y - 1, hair)
      text(buf, "└─", o.x - 1, o.y + o.h, hair)
      text(buf, "─┘", o.x + o.w - 1, o.y + o.h, hair)
    } else {
      // Tiny terminals: the orrery seen edge-on, one row tall.
      const sw = Math.max(20, Math.min(W - 4, 60))
      canvas.resize(sw, 1)
      canvas.aspect = 1
      canvas.clear()
      const states = TOOLS.map((k) => {
        const s = status?.tools.find((x) => x.key === k)
        return { key: k, installed: s?.installed ?? true, live: s?.live ?? 0 }
      })
      const selX = orrery.drawStrip(canvas, theme, states)
      canvas.blit(buf, 2, L.top + 1, bg)
      void selX
      const nm = `${t}${ts?.live ? `  ${ts.live} live` : ""}`
      if (2 + sw + 2 + nm.length <= W) text(buf, nm, 2 + sw + 2, L.top + 1, ink(), bg, TextAttributes.BOLD)
    }

    // The name: the only large thing on screen.
    const T = L.text
    let y = T.y
    const nameRows = L.mode === "wide" ? Math.max(3, Math.min(12, Math.floor(T.h * 0.2))) : Math.max(3, Math.min(10, Math.floor(T.h * 0.26)))
    const bm = L.mode === "tiny" ? null : fitWord(t, T.w, nameRows)
    // Centre the block (name, facts, actions) against the space it lives in.
    {
      const lsx = status?.lastSession
      const facts = 1 + (ts?.live ? 1 : 0) + (status && !status.workspace.mounted ? 1 : lsx ? (lsx.changed && lsx.risky.length ? 2 : 1) : 0)
      const blockH = (bm ? bm.h / 2 + 1 : 2) + facts + 1 + actions().length
      // Reader views keep the block at the top: they need the height.
      if (L.mode !== "tiny" && !reader) {
        const free = Math.max(0, T.h - blockH)
        y = T.y + (L.mode === "wide" ? Math.max(0, Math.floor(free / 2) - 1) : Math.floor(free * 0.3))
      }
    }
    const e = expoOut(nameT)
    if (bm) {
      if (prevTool >= 0 && nameT < 1) {
        const pk = TOOLS[prevTool]!
        const pbm = fitWord(pk, T.w, nameRows)
        if (pbm) drawWord(buf, pbm, T.x - Math.round(e * 4), y + bm.h / 2 - pbm.h / 2, ink(pk), bg, (1 - e) * (1 - recede * 0.4), T.x, T.x + T.w)
      }
      drawWord(buf, bm, T.x + Math.round((1 - e) * 5), y, ink(), bg, e, T.x, T.x + T.w + 1)
      y += bm.h / 2 + 1
    } else {
      text(buf, NAMES[t], T.x, y, ink(), bg, TextAttributes.BOLD, T.w)
      y += 1
    }

    // Who it is, and what state it's in.
    let x = T.x
    if (bm) x += text(buf, NAMES[t], x, y, theme.fg, bg, TextAttributes.BOLD, T.w)
    if (ts?.version) x += text(buf, bm ? `  ${ts.version}` : ts.version, x, y, theme.dim, bg, 0, T.x + T.w - x)
    if (ts) text(buf, `  ·  ${ts.exclusive ? "one session at a time" : "parallel sessions"}`, x, y, theme.dim, bg, 0, T.x + T.w - x)
    y += 1
    if (ts?.live) {
      const msg = ts.exclusive ? `● running in another terminal · a new launch is a throwaway` : `● ${ts.live} live session${ts.live > 1 ? "s" : ""}`
      text(buf, msg, T.x, y, ink(), bg, 0, T.w)
      y += 1
    }
    const ls = status?.lastSession
    if (status && !status.workspace.mounted) {
      text(buf, `◇ no project mounted here (${status.workspace.reason ?? "not a project"}) · starts in the sandbox home`, T.x, y, theme.dim, bg, 0, T.w)
      y += 1
    } else if (ls) {
      const f = expoOut(lastFade)
      const c = (col: RGB) => mix(bg, col, f)
      if (ls.changed) {
        let lx = T.x + text(buf, "last session  ", T.x, y, c(theme.dim))
        lx += text(buf, `${ls.changed} files changed`, lx, y, c(theme.fg), bg, 0, T.x + T.w - lx)
        text(buf, `  +${ls.added} ~${ls.modified} −${ls.deleted}`, lx, y, c(theme.dim), bg, 0, T.x + T.w - lx)
        y += 1
        if (ls.risky.length) {
          text(buf, `▲ host-executed files changed: ${ls.risky.join(", ")}  · review before running them outside umbra`, T.x, y, c(theme.warn), bg, 0, T.w)
          y += 1
        }
      } else {
        text(buf, "last session  no changes to this project", T.x, y, c(theme.dim), bg, 0, T.w)
        y += 1
      }
    }
    y += 1

    // Actions, or a reader view sliding over them on one axis.
    const list = actions()
    actionRows = []
    const listAlpha = 1 - recede
    if (listAlpha > 0.02) {
      const slide = Math.round(recede * -4)
      list.forEach((a, i) => {
        const ry = y + i
        if (ry >= T.y + T.h) return
        const isFocus = Math.round(pillY) === i && !reader
        const keyCol = isFocus ? bg : theme.dim
        const label = a.label
        const x0 = T.x + slide
        if (isFocus) {
          // The focused action is a pill in the tool's ink; it flashes on Enter.
          const pill = flash ? mix(ink(), theme.fg, 0.45) : mix(bg, ink(), listAlpha)
          buf.fillRect(x0 - 1, ry, Math.min(T.w, label.length + 6), 1, rgba(pill))
          text(buf, a.key, x0, ry, keyCol, pill, TextAttributes.BOLD)
          text(buf, label, x0 + 3, ry, bg, pill, TextAttributes.BOLD)
        } else {
          text(buf, a.key, x0, ry, mix(bg, keyCol, listAlpha))
          text(buf, label, x0 + 3, ry, mix(bg, a.disabled ? theme.dim : theme.fg, listAlpha), bg, a.disabled ? TextAttributes.STRIKETHROUGH : 0, T.w - 3)
        }
        const hx = x0 + 3 + label.length + 4
        if (a.hint && hx < T.x + T.w - 4) text(buf, a.hint, hx, ry, mix(bg, theme.dim, listAlpha), bg, 0, T.x + T.w - hx)
        actionRows.push({ y: ry, x0: x0, x1: x0 + 3 + label.length, idx: i })
      })
    }

    if (reader && recede > 0.02) {
      const r = reader
      const rx = T.x + Math.round((1 - recede) * 6)
      const head = mix(bg, theme.fg, recede)
      const n = text(buf, r.title, rx, y, head, bg, TextAttributes.BOLD, T.w)
      if (r.running) text(buf, `  ${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(performance.now() / 80) % 10]} running`, rx + n, y, mix(bg, ink(), recede))
      const ry0 = y + 2
      const rows = Math.max(1, T.y + T.h - ry0)
      const maxScroll = Math.max(0, r.lines.length - rows)
      r.scroll = Math.max(0, Math.min(r.scroll, maxScroll))
      if (!r.lines.length && !r.running) text(buf, r.empty, rx, ry0, mix(bg, theme.dim, recede), bg, 0, T.w)
      for (let i = 0; i < rows && r.scroll + i < r.lines.length; i++) {
        let lx = rx
        for (const sp of r.lines[r.scroll + i]!.spans) {
          const col =
            sp.ink === "fg" ? theme.fg : sp.ink === "dim" ? theme.dim : sp.ink === "ok" ? theme.ok : sp.ink === "warn" ? theme.warn : sp.ink === "danger" ? theme.danger : sp.ink === "halo" ? theme.halo : ink()
          lx += text(buf, sp.text, lx, ry0 + i, mix(bg, col, recede), bg, sp.bold ? TextAttributes.BOLD : 0, T.x + T.w - lx)
          if (lx >= T.x + T.w) break
        }
      }
      if (maxScroll > 0) text(buf, `${r.scroll + 1}–${Math.min(r.lines.length, r.scroll + rows)} of ${r.lines.length}`, rx, y + 1, theme.dim)
    }

    // Status line.
    const sy = L.bottom
    const hints = reader ? "↑↓ scroll  esc back" : "←→ tool  ↑↓ action  ⏎ run  q quit"
    const room = W - hints.length - 6 // what the left side may use
    let sx = 2
    const ws = status?.workspace
    sx += text(buf, "◆ ", sx, sy, ink())
    if (ws?.mounted) {
      sx += text(buf, umbra.elide(umbra.shortPath(ws.start ?? ws.root ?? cwd), Math.max(12, Math.min(Math.floor(W * 0.32), room - 4))), sx, sy, theme.fg, bg, 0, room - sx)
      if (ws.branch && sx + ws.branch.length + 2 < room) sx += text(buf, `  ${ws.branch}`, sx, sy, theme.dim)
      const snaps = status!.snapshots
      const snapText = `  ·  ${snaps.count} snapshot${snaps.count > 1 ? "s" : ""}, last ${umbra.age(snaps.ageSeconds)}`
      if (snaps.count && sx + snapText.length < room) sx += text(buf, snapText, sx, sy, theme.dim)
    } else {
      sx += text(buf, umbra.elide(umbra.shortPath(cwd), Math.max(12, Math.min(Math.floor(W * 0.32), room - 4))), sx, sy, theme.dim, bg, 0, room - sx)
    }
    const liveOthers = (status?.tools ?? []).filter((x) => x.live > 0 && x.key !== t)
    for (const o of liveOthers) if (sx + o.key.length + 10 < room) sx += text(buf, `  ·  ${o.key} live`, sx, sy, ink(o.key))
    {
      const hx = W - 2 - hints.length
      // keys in fg, words dim
      let cx = hx
      for (const part of hints.split(/(\s+)/)) {
        const isKey = /^[↑↓←→⏎]+$|^esc$|^q$/.test(part)
        cx += text(buf, part, cx, sy, isKey ? theme.fg : theme.dim)
      }
    }

    // Last: the ASCII nebula fills whatever cells are still empty sky.
    nebula.paint(buf, theme, ink(), recede, core, dotAspect() * 2)
  }
}
