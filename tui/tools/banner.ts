// Renders the README banner with the TUI's own drawing code: the same
// orrery, canvas and baked display type, composed for a wide frame. Writes a
// truecolor ANSI frame to stdout (`cat` it to preview in a terminal);
// tools/banner-png.py rasterises it the way kitty draws cells.
//
//   bun tools/banner.ts dark  > banner-dark.ansi
//   bun tools/banner.ts light > banner-light.ansi
//
// The dark frame uses the theme's fallback palette (the author's wallpaper
// colours); the light one runs the same palette through the light-theme
// path of buildTheme, as the TUI would on a light terminal.

import type { RGBA } from "@opentui/core"
import { DotCanvas } from "../src/canvas"
import { mix, type RGB } from "../src/color"
import { Orrery } from "../src/orrery"
import { buildTheme } from "../src/theme"
import { drawWord } from "../src/type"
import type { Bitmap } from "../src/typebake"

const W = 128
const H = 26
const variant = process.argv[2] === "light" ? "light" : "dark"
const theme = variant === "light" ? buildTheme([], "#2B2625", "#F4EFEC") : buildTheme()
const bg = theme.bg

interface Cell {
  ch: string
  fg: RGB
  bg: RGB
  bold: boolean
}
const grid: Cell[] = Array.from({ length: W * H }, () => ({ ch: " ", fg: theme.fg, bg, bold: false }))
const toRGB = (c: RGBA): RGB => c.toInts().slice(0, 3) as unknown as RGB

// The slice of OptimizedBuffer that canvas.blit and drawWord use.
const buf = {
  setCell(x: number, y: number, ch: string, fg: RGBA, cbg: RGBA): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    grid[y * W + x] = { ch, fg: toRGB(fg), bg: toRGB(cbg), bold: false }
  },
}
function text(s: string, x: number, y: number, fg: RGB, opts: { bold?: boolean; bg?: RGB } = {}): number {
  ;[...s].forEach((ch, k) => {
    const i = y * W + x + k
    if (x + k < W) grid[i] = { ch, fg, bg: opts.bg ?? grid[i]!.bg, bold: !!opts.bold }
  })
  return [...s].length
}

// ---- the orrery, left: claude selected, egress "ask", everything settled
const O = { x: 3, y: 2, w: 60, h: 21 }
const state = [
  { key: "claude", installed: true, live: 0 },
  { key: "opencode", installed: true, live: 0 },
  { key: "agy", installed: true, live: 0 },
]
const orrery = new Orrery(state.length, false)
for (let t = 0; t < 9; t += 1 / 30) orrery.update(1 / 30)
const canvas = new DotCanvas()
canvas.resize(O.w, O.h)
canvas.clear()
const labels = orrery.draw(canvas, { x: 0, y: 0, w: O.w * 2, h: O.h * 4 }, theme, state, "ask", 0)
canvas.blit(buf as never, O.x, O.y, bg)
for (const l of labels) {
  const ink = l.selected ? theme.tool[l.key]! : theme.dim
  ;[...l.key].forEach((ch, k) => {
    const under = canvas.cellColor(l.x + k, l.y) ?? bg
    text(ch, O.x + l.x + k, O.y + l.y, ink, { bold: l.selected, bg: under })
  })
}
text("┌─", O.x - 1, O.y - 1, theme.hair)
text("─┐", O.x + O.w - 1, O.y - 1, theme.hair)
text("└─", O.x - 1, O.y + O.h, theme.hair)
text("─┘", O.x + O.w - 1, O.y + O.h, theme.hair)

// ---- the mark, right: "umbra" in the display face, then the tools as the
// TUI's action rows, the selected one on its pill
const TX = O.x + O.w + 6
const bakeWord = (h: number): Bitmap =>
  JSON.parse(Bun.spawnSync(["python3", "-I", `${import.meta.dir}/bake-type.py`, "--word", "umbra", "--height", String(h)]).stdout.toString())
// the largest size whose width leaves room for "v2.0" beside it
let word = bakeWord(24)
for (let h = 23; word.w > W - TX - 8 && h > 8; h--) word = bakeWord(h)
const tools: [string, string][] = [
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
  ["agy", "Antigravity"],
]
const blockH = word.h / 2 + 1 + 1 + 1 + 1 + tools.length
let y = Math.floor((H - blockH) / 2) - 1
drawWord(buf as never, word, TX, y, theme.fg, bg)
text("v2.0", TX + word.w + 2, y + word.h / 2 - 1, theme.dim)
y += word.h / 2 + 1
text("Your AI coding CLIs, each in its own microVM.", TX, y, theme.fg, { bold: true })
y += 1
text("Native in your terminal. Your laptop stays out of reach.", TX, y, theme.dim)
y += 2
tools.forEach(([key, name], i) => {
  const ink = theme.tool[key]!
  if (i === 0) {
    // the focused pill: one cell left of the key to 6 past the label
    for (let x = TX - 1; x < TX + 10 + name.length + 6; x++) text(" ", x, y, ink, { bg: ink })
    text("⏎", TX, y, theme.bg, { bold: true, bg: ink })
    text(key, TX + 3, y, theme.bg, { bold: true, bg: ink })
    text(name, TX + 13, y, mix(theme.bg, ink, 0.28), { bg: ink })
  } else {
    text("●", TX, y, ink)
    text(key, TX + 3, y, theme.fg)
    text(name, TX + 13, y, theme.dim)
  }
  y += 1
})

// ---- status line, as in the TUI: ◆ in the tool's ink, egress mode in halo
const SY = H - 2
let sx = 2
sx += text("◆ ", sx, SY, theme.tool.claude!)
text("snapshot before every session  ·  undo in one key  ·  egress asks first", sx, SY, theme.dim)
const right = "egress ask"
text("egress ", W - 2 - right.length, SY, theme.dim)
text("ask", W - 2 - 3, SY, theme.halo, { bold: true })

// ---- out, as SGR truecolor
const sgr = (c: RGB) => c.map((v) => Math.round(v)).join(";")
let out = ""
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    const cell = grid[r * W + c]!
    out += `\x1b[0;${cell.bold ? "1;" : ""}38;2;${sgr(cell.fg)};48;2;${sgr(cell.bg)}m${cell.ch}`
  }
  out += "\x1b[0m\n"
}
process.stdout.write(out)
