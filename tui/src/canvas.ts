import type { OptimizedBuffer } from "@opentui/core"
import { mix, rgba, type RGB } from "./color"

// A cell canvas with two resolutions, composited per cell:
//   - "dots": braille, 2x4 per cell, for hairlines (orbits, halo, rings).
//     Two layers: back (behind fills) and front (drawn over fills).
//   - "fill": half-blocks, 1x2 per cell, for solid shapes with soft,
//     colour-blended edges (core, corona glow, bodies).
// Coordinates for drawing calls are in dot space (2*cols x 4*rows), whose
// pixels are roughly square in common terminal fonts; a fill pixel is a
// 2x2 block of dots.

const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export type Layer = "back" | "front"

export class DotCanvas {
  cols = 0
  rows = 0
  private backBits = new Uint8Array(0)
  private frontBits = new Uint8Array(0)
  private backInk: (RGB | null)[] = []
  private frontInk: (RGB | null)[] = []
  private top: (RGB | null)[] = []
  private bot: (RGB | null)[] = []

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    const n = cols * rows
    this.backBits = new Uint8Array(n)
    this.frontBits = new Uint8Array(n)
    this.backInk = new Array(n).fill(null)
    this.frontInk = new Array(n).fill(null)
    this.top = new Array(n).fill(null)
    this.bot = new Array(n).fill(null)
  }

  clear(): void {
    this.backBits.fill(0)
    this.frontBits.fill(0)
    this.backInk.fill(null)
    this.frontInk.fill(null)
    this.top.fill(null)
    this.bot.fill(null)
  }

  get width(): number {
    return this.cols * 2
  }
  get height(): number {
    return this.rows * 4
  }

  dot(x: number, y: number, ink: RGB, layer: Layer = "back"): void {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    if (xi < 0 || yi < 0 || xi >= this.cols * 2 || yi >= this.rows * 4) return
    const cell = (yi >> 2) * this.cols + (xi >> 1)
    const bit = BRAILLE[yi & 3]![xi & 1]!
    if (layer === "front") {
      this.frontBits[cell]! |= bit
      this.frontInk[cell] = ink
    } else {
      this.backBits[cell]! |= bit
      this.backInk[cell] = ink
    }
  }

  private fillAt(hx: number, hy: number): RGB | null {
    const cell = (hy >> 1) * this.cols + hx
    return (hy & 1 ? this.bot[cell] : this.top[cell]) ?? null
  }

  private setFill(hx: number, hy: number, c: RGB): void {
    if (hx < 0 || hy < 0 || hx >= this.cols || hy >= this.rows * 2) return
    const cell = (hy >> 1) * this.cols + hx
    if (hy & 1) this.bot[cell] = c
    else this.top[cell] = c
  }

  /** Solid disc with anti-aliased edge, blended over what's already filled (or bg). */
  disc(cx: number, cy: number, r: number, ink: RGB, bg: RGB, alpha = 1): void {
    if (r <= 0.2 || alpha <= 0) return
    const hx0 = Math.max(0, Math.floor((cx - r) / 2) - 1)
    const hx1 = Math.min(this.cols - 1, Math.ceil((cx + r) / 2) + 1)
    const hy0 = Math.max(0, Math.floor((cy - r) / 2) - 1)
    const hy1 = Math.min(this.rows * 2 - 1, Math.ceil((cy + r) / 2) + 1)
    for (let hy = hy0; hy <= hy1; hy++) {
      for (let hx = hx0; hx <= hx1; hx++) {
        // 4x4 supersampling over the 2x2-dot pixel
        let inside = 0
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const px = hx * 2 + (sx + 0.5) / 2
            const py = hy * 2 + (sy + 0.5) / 2
            const dx = px - cx
            const dy = py - cy
            if (dx * dx + dy * dy <= r * r) inside++
          }
        }
        if (!inside) continue
        const cov = (inside / 16) * alpha
        const under = this.fillAt(hx, hy) ?? bg
        this.setFill(hx, hy, mix(under, ink, cov))
      }
    }
  }

  /** Soft radial glow between r0 and r1, strongest at r0. */
  glow(cx: number, cy: number, r0: number, r1: number, ink: RGB, bg: RGB, strength: number): void {
    if (strength <= 0 || r1 <= r0) return
    const hx0 = Math.max(0, Math.floor((cx - r1) / 2))
    const hx1 = Math.min(this.cols - 1, Math.ceil((cx + r1) / 2))
    const hy0 = Math.max(0, Math.floor((cy - r1) / 2))
    const hy1 = Math.min(this.rows * 2 - 1, Math.ceil((cy + r1) / 2))
    for (let hy = hy0; hy <= hy1; hy++) {
      for (let hx = hx0; hx <= hx1; hx++) {
        const d = Math.hypot(hx * 2 + 1 - cx, hy * 2 + 1 - cy)
        if (d < r0 || d > r1) continue
        const t = (d - r0) / (r1 - r0)
        const a = strength * (1 - t) * (1 - t)
        if (a < 0.02) continue
        const under = this.fillAt(hx, hy) ?? bg
        this.setFill(hx, hy, mix(under, ink, a))
      }
    }
  }

  /**
   * Ellipse outline (rotated by `rot` radians). `part` keeps only the half
   * nearer to (front) or farther from (back) the viewer: the orbit plane is
   * tilted toward us, so sin(theta) > 0 is in front. `dash` = [on, off] in
   * samples; `frac` draws only the first fraction of the path (entrance).
   */
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rot: number,
    ink: RGB,
    opts: { part?: "front" | "back" | "all"; layer?: Layer; dash?: [number, number]; phase?: number; frac?: number } = {},
  ): void {
    const part = opts.part ?? "all"
    const frac = opts.frac ?? 1
    const steps = Math.max(48, Math.ceil(Math.PI * (rx + ry) * 1.6))
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const layer = opts.layer ?? (part === "front" ? "front" : "back")
    const limit = Math.floor(steps * frac)
    for (let i = 0; i < limit; i++) {
      if (opts.dash) {
        const period = opts.dash[0] + opts.dash[1]
        const k = (i + Math.floor(opts.phase ?? 0)) % period
        if (k >= opts.dash[0]) continue
      }
      const th = (i / steps) * Math.PI * 2 + Math.PI / 2
      const s = Math.sin(th)
      if (part === "front" && s < 0) continue
      if (part === "back" && s >= 0) continue
      const ex = rx * Math.cos(th)
      const ey = ry * s
      this.dot(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr, ink, layer)
    }
  }

  ring(cx: number, cy: number, r: number, ink: RGB, opts: { layer?: Layer; dash?: [number, number]; phase?: number; gapAt?: number; gap?: number } = {}): void {
    const steps = Math.max(24, Math.ceil(2 * Math.PI * r * 1.4))
    for (let i = 0; i < steps; i++) {
      if (opts.dash) {
        const period = opts.dash[0] + opts.dash[1]
        const k = (i + Math.floor(opts.phase ?? 0)) % period
        if (k >= opts.dash[0]) continue
      }
      const th = (i / steps) * Math.PI * 2
      if (opts.gap) {
        let d = Math.abs(th - (opts.gapAt ?? Math.PI / 2))
        d = Math.min(d, Math.PI * 2 - d)
        if (d < opts.gap / 2) continue
      }
      this.dot(cx + r * Math.cos(th), cy + r * Math.sin(th), ink, opts.layer ?? "back")
    }
  }

  /** Removes front hairline dots under a disc: a body hides the orbit behind it. */
  clearFront(cx: number, cy: number, r: number): void {
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(this.cols * 2 - 1, Math.ceil(cx + r + 1))
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(this.rows * 4 - 1, Math.ceil(cy + r + 1))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy > (r + 0.6) * (r + 0.6)) continue
        const cell = (y >> 2) * this.cols + (x >> 1)
        this.frontBits[cell]! &= ~BRAILLE[y & 3]![x & 1]!
        this.backBits[cell]! &= ~BRAILLE[y & 3]![x & 1]!
      }
    }
  }

  /** The colour a cell shows behind text (its fill's mean), or null if unfilled. */
  cellColor(col: number, row: number): RGB | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null
    const i = row * this.cols + col
    const t = this.top[i]
    const b = this.bot[i]
    if (!t && !b) return null
    return t && b ? mix(t, b, 0.5) : (t ?? b)!
  }

  /** Composites the canvas into `buf` at cell offset (ox, oy). */
  blit(buf: OptimizedBuffer, ox: number, oy: number, bg: RGB): void {
    const bgc = rgba(bg)
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c
        const t = this.top[i]
        const b = this.bot[i]
        const fb = this.frontBits[i]!
        if (t || b) {
          const tt = t ?? bg
          const bb = b ?? bg
          if (fb) {
            // A front hairline crossing a filled cell: braille over the fill's mean colour.
            buf.setCell(ox + c, oy + r, String.fromCharCode(0x2800 + fb), rgba(this.frontInk[i]!), rgba(mix(tt, bb, 0.5)))
          } else {
            buf.setCell(ox + c, oy + r, "▀", rgba(tt), rgba(bb))
          }
          continue
        }
        const bits = fb | this.backBits[i]!
        if (bits) {
          const ink = fb ? this.frontInk[i]! : this.backInk[i]!
          buf.setCell(ox + c, oy + r, String.fromCharCode(0x2800 + bits), rgba(ink), bgc)
        }
      }
    }
  }
}
