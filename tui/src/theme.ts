import type { CliRenderer } from "@opentui/core"
import { ensureContrast, hex, luminance, mix, type RGB } from "./color"

// Every colour on screen comes from the terminal's own palette (on the
// author's machine: generated from the wallpaper and re-applied whenever it
// changes). This fallback only applies when the terminal doesn't answer
// OSC 4/10/11 palette queries.
const FALLBACK = [
  "#141414", "#FF98AB", "#73C791", "#C4B84E", "#65C1EC", "#CDA6F6", "#4EC7CD", "#ADABAA",
  "#92908F", "#FFADBC", "#8CD3A6", "#D2C66A", "#86CDF2", "#D6B7FB", "#77D2D8", "#C6C3C3",
]

export interface Theme {
  dark: boolean
  bg: RGB
  fg: RGB
  /** secondary text, >= 4.5:1 on bg */
  dim: RGB
  /** hairlines: orbits, registration ticks, rules */
  hair: RGB
  /** the sealed core: the deepest shadow on screen */
  core: RGB
  /** egress halo */
  halo: RGB
  warn: RGB
  danger: RGB
  ok: RGB
  tool: Record<string, RGB>
}

export const TOOL_INK: Record<string, number> = { claude: 1, opencode: 4, agy: 2 }

export function buildTheme(palette: (string | null)[] = [], fgHex?: string | null, bgHex?: string | null): Theme {
  const p = (i: number): RGB => hex(palette[i] ?? FALLBACK[i]!)
  const bg = bgHex ? hex(bgHex) : p(0)
  const fg = fgHex ? hex(fgHex) : p(15)
  const dark = luminance(bg) < 0.35
  const black: RGB = [0, 0, 0]
  const inks = (i: number): RGB => ensureContrast(p(i), bg, fg, 3)
  return {
    dark,
    bg,
    fg: ensureContrast(fg, bg, dark ? [255, 255, 255] : black, 7),
    dim: ensureContrast(p(8), bg, fg, 4.5),
    hair: mix(bg, fg, dark ? 0.28 : 0.35),
    core: dark ? mix(bg, black, 0.6) : mix(fg, bg, 0.12),
    halo: inks(5),
    warn: inks(3),
    danger: inks(1),
    ok: inks(2),
    tool: { claude: inks(TOOL_INK.claude!), opencode: inks(TOOL_INK.opencode!), agy: inks(TOOL_INK.agy!) },
  }
}

export async function detectTheme(renderer: CliRenderer): Promise<Theme> {
  try {
    const c = await renderer.getPalette({ timeout: 400 })
    if (!c.palette.some(Boolean)) return buildTheme()
    return buildTheme(c.palette, c.defaultForeground, c.defaultBackground)
  } catch {
    return buildTheme()
  }
}
