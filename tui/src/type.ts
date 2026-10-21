import type { OptimizedBuffer } from "@opentui/core"
import { mix, rgba, type RGB } from "./color"
import { TYPE, type Bitmap } from "./typebake"

// The display voice: tool names in URW Gothic Demi, pre-rasterised into
// coverage bitmaps (src/typebake.ts) and drawn as half-block pixels with
// colour-blended edges. Only the selected tool's name is ever this large.

const decoded = new Map<string, Uint8Array>()
function pixels(bm: Bitmap): Uint8Array {
  let px = decoded.get(bm.data)
  if (!px) {
    px = Uint8Array.from(atob(bm.data), (ch) => ch.charCodeAt(0))
    decoded.set(bm.data, px)
  }
  return px
}

// Edge pixels blend in (partly) linear light: a plain sRGB mix of light ink
// on night makes half-covered pixels too dark, a fringe that makes the
// half-block steps read as jagged. The full 2.2 swells the strokes and
// closes the counters at these sizes; 1.6 smooths the steps and stays crisp.
const GAMMA = 1.6
const toLin = (v: number): number => (v / 255) ** GAMMA
const toSrgb = (v: number): number => 255 * v ** (1 / GAMMA)
function blend(bg: RGB, ink: RGB, t: number): RGB {
  if (t >= 0.999) return ink
  return [
    toSrgb(toLin(bg[0]) + (toLin(ink[0]) - toLin(bg[0])) * t),
    toSrgb(toLin(bg[1]) + (toLin(ink[1]) - toLin(bg[1])) * t),
    toSrgb(toLin(bg[2]) + (toLin(ink[2]) - toLin(bg[2])) * t),
  ]
}

/** Largest baked size of `word` that fits in maxCols x maxRows cells. */
export function fitWord(word: string, maxCols: number, maxRows: number): Bitmap | null {
  const sizes = TYPE[word]
  if (!sizes) return null
  let best: Bitmap | null = null
  for (const bm of sizes) {
    if (bm.w <= maxCols && bm.h / 2 <= maxRows) best = bm
  }
  return best
}

/** Rows a word occupies at the size fitWord picks for this space, or 0. */
export function wordRows(word: string, maxCols: number, maxRows: number): number {
  const bm = fitWord(word, maxCols, maxRows)
  return bm ? bm.h / 2 : 0
}

/**
 * Draws `bm` at cell (x, y). `alpha` fades it toward bg; columns outside
 * [clipX0, clipX1) are skipped (used while a name slides).
 */
export function drawWord(
  buf: OptimizedBuffer,
  bm: Bitmap,
  x: number,
  y: number,
  ink: RGB,
  bg: RGB,
  alpha = 1,
  clipX0 = -Infinity,
  clipX1 = Infinity,
): void {
  const px = pixels(bm)
  const rows = bm.h / 2
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < bm.w; c++) {
      const cx = x + c
      if (cx < clipX0 || cx >= clipX1) continue
      const a = (px[2 * r * bm.w + c]! / 255) * alpha
      const b = (px[(2 * r + 1) * bm.w + c]! / 255) * alpha
      if (a < 0.03 && b < 0.03) continue
      buf.setCell(cx, y + r, "▀", rgba(blend(bg, ink, a)), rgba(blend(bg, ink, b)))
    }
  }
}
