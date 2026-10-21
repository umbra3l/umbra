import type { OptimizedBuffer } from "@opentui/core"
import { mix, type RGB } from "./color"
import type { Theme } from "./theme"

// An ASCII nebula behind the whole TUI: coloured glyphs (" .:-=+*#%@") over
// two slowly drifting gas layers, tinted from the theme's own palette and the
// selected tool's ink. It is painted LAST, into cells nothing else used, and
// thins out next to text, so it fills every layout at every size without
// stepping on the UI.
//
// The pointer stirs it: hovering swirls the gas around the cursor and leaves
// a fading wake; a click sends a shockwave ring out through the cloud.
//
// The turbulence is baked ONCE into a small tileable buffer (periodic noise)
// at a fixed cell scale, so a resize costs nothing and the clouds keep their
// size whatever the window does. Frozen flat under reduced motion.

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

function phash(xi: number, yi: number, px: number, py: number): number {
  xi = ((xi % px) + px) % px
  yi = ((yi % py) + py) % py
  const s = Math.sin(xi * 127.1 + yi * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function pnoise(x: number, y: number, px: number, py: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = smooth(x - xi)
  const v = smooth(y - yi)
  const a = phash(xi, yi, px, py)
  const b = phash(xi + 1, yi, px, py)
  const c = phash(xi, yi + 1, px, py)
  const d = phash(xi + 1, yi + 1, px, py)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
// Periodic fBm over (px, py): every octave wraps its lattice, so the sum
// tiles seamlessly in both axes.
function pfbm(x: number, y: number, px: number, py: number, oct: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(x * freq, y * freq, px * freq, py * freq)
    freq *= 2
    amp *= 0.5
  }
  return sum
}

// Field size in field pixels; one cell is 0.5 x 1 field pixels (cells are
// about twice as tall as wide), so the tile spans 384 x 96 cells.
const FW = 192
const FH = 96
const PX = 8 // noise periods across the tile
const PY = 4

const RAMP = " .:-=+*#%@"
const FEATHER = 0.2
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16 - 0.5))

// Calm margin around text, by offset (rows -2..2, cols -5..5): an ellipse
// of empty sky at the glyph that fades back to full cloud.
const CALM = Float32Array.from({ length: 55 }, (_, i) => {
  const dy = Math.floor(i / 11) - 2
  const dx = (i % 11) - 5
  const d = Math.hypot(dx / 5.5, dy / 2.5)
  return d < 0.3 ? 0 : smooth((d - 0.3) / 0.7)
})

interface Mark {
  x: number // cells
  y: number
  t: number // nebula clock, seconds
}

const TRAIL_LIFE = 1.4
const PULSE_LIFE = 1.6
const IDLE_HOLD = 2.5 // the pointer's swirl holds this long after the last move...
const IDLE_FADE = 2.5 // ...then fades out over this long

export class Nebula {
  reduced: boolean
  private gas = new Float32Array(0) // soft cloud density, 0..1
  private fil = new Float32Array(0) // ridged filaments, 0..1
  private hue = new Float32Array(0) // slow colour field, 0..1
  private quiet = new Float32Array(0) // per-cell: 0 occupied .. 1 open sky
  private pointer: Mark | null = null
  private trail: Mark[] = []
  private pulses: Mark[] = []
  private clock = 0

  constructor(reduced: boolean) {
    this.reduced = reduced
  }

  private bake(): void {
    const n = FW * FH
    this.gas = new Float32Array(n)
    this.fil = new Float32Array(n)
    this.hue = new Float32Array(n)
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const nx = (x / FW) * PX
        const ny = (y / FH) * PY
        // The domain warp shares the period, so everything stays tileable.
        const wx = pfbm(nx + 1.3, ny + 4.2, PX, PY, 3)
        const wy = pfbm(nx + 2.8, ny + 1.7, PX, PY, 3)
        const g = pfbm(nx + wx * 1.6, ny + wy * 1.6, PX, PY, 5)
        const r = pfbm(nx * 2 + wy * 2.4, ny * 2 + wx * 2.4, PX * 2, PY * 2, 4)
        const i = y * FW + x
        this.gas[i] = g
        this.fil[i] = Math.max(0, 1 - Math.abs(r - 0.5) * 3.2)
        this.hue[i] = pnoise(nx * 0.5 + 7.7, ny * 0.5 + 3.1, PX / 2, PY / 2)
      }
    }
  }

  private sample(f: Float32Array, x: number, y: number): number {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const xa = ((x0 % FW) + FW) % FW
    const ya = ((y0 % FH) + FH) % FH
    const xb = xa + 1 === FW ? 0 : xa + 1
    const yb = ya + 1 === FH ? 0 : ya + 1
    const top = f[ya * FW + xa]! + (f[ya * FW + xb]! - f[ya * FW + xa]!) * fx
    const bot = f[yb * FW + xa]! + (f[yb * FW + xb]! - f[yb * FW + xa]!) * fx
    return top + (bot - top) * fy
  }

  /** The pointer moved to cell (x, y). */
  hover(x: number, y: number): void {
    const m = { x, y, t: this.clock }
    const last = this.trail[this.trail.length - 1]
    if (!last || this.clock - last.t > 0.03 || Math.abs(last.x - x) + Math.abs(last.y - y) > 3) this.trail.push(m)
    if (this.trail.length > 48) this.trail.shift()
    this.pointer = m
  }

  /** A click at cell (x, y): a shockwave rolls out through the gas. */
  pulse(x: number, y: number): void {
    this.pulses.push({ x, y, t: this.clock })
    if (this.pulses.length > 6) this.pulses.shift()
    this.hover(x, y)
  }

  private presence(): number {
    if (!this.pointer) return 0
    return 1 - smooth((this.clock - this.pointer.t - IDLE_HOLD) / IDLE_FADE)
  }

  /** True while the pointer is still shaping the gas: worth 60fps. */
  get stirring(): boolean {
    return this.pointer !== null || this.trail.length > 0 || this.pulses.length > 0
  }

  /** Advances the nebula's own clock (drift, wake decay). */
  update(dt: number): void {
    this.clock += dt
    const c = this.clock
    while (this.trail.length && c - this.trail[0]!.t > TRAIL_LIFE) this.trail.shift()
    while (this.pulses.length && c - this.pulses[0]!.t > PULSE_LIFE) this.pulses.shift()
    if (this.pointer && this.presence() <= 0) this.pointer = null
  }

  /**
   * Paints the nebula into every free cell of `buf`: a plain-background space
   * nothing else drew on. Call it after everything else. `accent` tints the
   * gas toward the selected tool; `core` (cells; radius in columns) keeps a
   * soft hole around the orrery's core; `dimmed` recedes it with the scene
   * behind reader views; `cellAspect` is a cell's height over its width.
   */
  paint(buf: OptimizedBuffer, theme: Theme, accent: RGB, dimmed: number, core?: { x: number; y: number; r: number }, cellAspect = 2): void {
    if (!this.gas.length) this.bake()
    const W = buf.width
    const H = buf.height
    if (W <= 0 || H <= 0) return
    const { char: chars, fg: fgs, bg: bgs } = buf.buffers
    const bg = theme.bg
    const bgR = Math.round(bg[0])
    const bgG = Math.round(bg[1])
    const bgB = Math.round(bg[2])

    // Which cells are free, and how quiet each must stay. Text and fills get
    // a one-to-two cell margin so words never sit in the gas; braille
    // hairlines (orbits, stars) only block their own cell, so the gas
    // threads between the orbits.
    const n = W * H
    if (this.quiet.length !== n) this.quiet = new Float32Array(n)
    const q = this.quiet
    q.fill(1)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const ch = chars[i]!
        const j = i * 4
        if (ch === 32 && bgs[j] === bgR && bgs[j + 1] === bgG && bgs[j + 2] === bgB) continue
        q[i] = 0
        if (ch >= 0x2800 && ch <= 0x28ff) continue
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -5; dx <= 5; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            const k = yy * W + xx
            const v = CALM[(dy + 2) * 11 + dx + 5]!
            if (v < q[k]!) q[k] = v
          }
        }
      }
    }

    const t = this.reduced ? 0 : this.clock
    const strength = (theme.dark ? 1 : 0.7) * (1 - Math.min(0.85, dimmed * 0.7))
    if (strength <= 0.02) return
    // A slow swell so the whole cloud breathes; two layers drift apart.
    const swell = this.reduced ? 1 : 0.86 + 0.14 * Math.sin(t * 0.37)
    const ax = t * 1.1
    const ay = t * 0.22
    const bx = -t * 0.8
    const by = t * 0.35

    // Interaction marks in field pixels: the live pointer, its wake, pulses.
    const pres = this.presence()
    const stirs: { x: number; y: number; w: number }[] = []
    for (const m of this.trail) {
      const a = 1 - (this.clock - m.t) / TRAIL_LIFE
      if (a > 0) stirs.push({ x: m.x * 0.5, y: m.y, w: a * a * 0.5 })
    }
    if (this.pointer && pres > 0) stirs.push({ x: this.pointer.x * 0.5, y: this.pointer.y, w: pres })
    const waves = this.pulses.map((p) => {
      const age = (this.clock - p.t) / PULSE_LIFE
      return { x: p.x * 0.5, y: p.y, r: 1.5 + smooth(Math.min(1, age * 1.15)) * 34, a: (1 - age) * (1 - age) }
    })
    const SR = 6.5 // swirl radius in field px (~13 columns, ~6 rows)
    const SR2 = SR * SR
    const spin = this.reduced ? 0 : 2.1 + 0.5 * Math.sin(t * 2.1)

    // Palette: cool halo -> the tool's accent -> warm; dense knots run toward fg.
    const cool = theme.halo
    const hot = theme.warn
    const fgc = theme.fg

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const quiet = q[i]!
        if (quiet <= 0) continue
        let u = x * 0.5
        let v = y
        let lift = 0 // pointer: brightens the gas that is there
        let wave = 0 // shockwave: lights even empty sky
        // Stir: rotate the sample point around each mark with a gaussian
        // falloff, so the gas visibly swirls around the cursor.
        for (const s of stirs) {
          const dx = u - s.x
          const dy = v - s.y
          const d2 = dx * dx + dy * dy
          if (d2 > SR2 * 6) continue
          const f = Math.exp(-d2 / SR2) * s.w
          const ang = f * spin
          const ca = Math.cos(ang)
          const sa = Math.sin(ang)
          u = s.x + dx * ca - dy * sa
          v = s.y + dx * sa + dy * ca
          lift += f * 0.4
        }
        for (const w of waves) {
          const ex = x * 0.5 - w.x
          const ey = y - w.y
          const d = Math.sqrt(ex * ex + ey * ey)
          const k = (d - w.r) / 2.2
          if (k <= -3 || k >= 3) continue
          const e = Math.exp(-k * k) * w.a
          wave += e * 0.8
          // The wave front shoves the gas outward as it passes.
          u += (ex / (d + 0.001)) * e * 2.5
          v += (ey / (d + 0.001)) * e * 2.5
        }

        const g = this.sample(this.gas, u + ax, v + ay)
        const fl = this.sample(this.fil, u * 1.3 + bx + 61, v * 1.3 + by + 23)
        // Clouds only where the gas is thick; within them the filaments carry
        // the brightness, so it reads as wisps over dark voids, not a wash.
        const dens = smooth((g - 0.47) / 0.26)
        lift = Math.min(0.7, lift)
        const gasI = dens * (0.12 + 0.75 * fl * fl * fl) + dens * dens * dens * 0.18
        let I = gasI * swell * (1 + lift * 1.6) + lift * dens * 0.25 + wave * (0.35 + dens * 0.4)
        lift = Math.min(1, lift + wave)
        if (core) {
          const d = Math.hypot(x - core.x, (y - core.y) * cellAspect)
          I *= 0.15 + 0.85 * smooth((d - core.r * 1.2) / (core.r * 2.6))
        }
        I *= strength * quiet

        // Feather the thin edge of every cloud: below FEATHER, a cell only
        // lights if it beats its dither threshold, so edges dissolve into
        // scattered dots instead of ending in a flat carpet.
        const th = BAYER[y & 3]![x & 3]! + 0.5
        if (I < 0.035 || (I < FEATHER && I / FEATHER < th)) {
          // Sparse stars in the dark gaps; they flare when the pointer passes.
          const hs = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
          const r = hs - Math.floor(hs)
          if (r > 0.992 && quiet > 0.5) {
            const tw = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * (1.3 + r * 40) + r * 900)
            const c = mix(bg, mix(theme.hair, fgc, Math.min(1, lift * 2.5)), (0.5 + tw * 0.5) * strength)
            this.put(chars, fgs, i, tw > 0.85 || lift > 0.2 ? 43 /* + */ : 46 /* . */, c)
          }
          continue
        }

        // Mostly faint glyphs; only the densest knots reach # % @.
        const level = Math.max(1, Math.min(RAMP.length - 1, Math.round(Math.pow(Math.min(1, I), 1.35) * (RAMP.length - 1) + BAYER[y & 3]![x & 3]!)))
        const h = this.sample(this.hue, u * 0.6 + 40, v * 0.6 + 17)
        const tone = h < 0.5 ? mix(cool, accent, smooth(h * 2)) : mix(accent, hot, smooth((h - 0.5) * 2) * 0.75)
        const lit = mix(tone, fgc, Math.min(0.4, Math.max(0, I - 0.8) * 0.8 + lift * 0.25))
        this.put(chars, fgs, i, RAMP.charCodeAt(level), mix(bg, lit, Math.min(0.82, 0.2 + I * 0.62)))
      }
    }
  }

  // Writes straight into the buffer: the glyphs are all single-width ASCII,
  // so no grapheme bookkeeping is needed, and it avoids ~20k FFI calls.
  private put(chars: Uint32Array, fgs: Uint16Array, i: number, code: number, c: RGB): void {
    chars[i] = code
    const j = i * 4
    fgs[j] = Math.round(c[0])
    fgs[j + 1] = Math.round(c[1])
    fgs[j + 2] = Math.round(c[2])
    fgs[j + 3] = 255
  }
}
