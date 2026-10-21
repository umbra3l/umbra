import type { DotCanvas } from "./canvas"
import { mix, type RGB } from "./color"
import type { Theme } from "./theme"

// The signature: each tool is a body on its own tilted orbit around the
// sealed core. Every mark is real state:
//   - rings around a body = live sessions of that tool (umbra runtime dirs);
//   - the core's halo = the selected tool's egress mode
//       ask    dashed ring, slowly turning (asks before new domains)
//       strict tight dotted ring, still
//       open   one faint solid ring
//       host   a ring opened toward you
//       none   no halo
//   - a hollow body = tool not installed.
// Positions on the orbits are not data; they only keep the system alive.

export interface BodyState {
  key: string
  installed: boolean
  live: number
}

const TILT = -0.24 // radians, orbit plane leaning left
const FRONT = Math.PI / 2 // nearest point to the viewer (bottom of the ellipse)
// Orbit radii as fractions of the outermost. Evenly spread from just outside
// the corona, so the system reads as three distinct lanes, not one band.
const ORBIT_K = [0.56, 0.78, 1.0]
const DRIFT = [0.021, 0.014, 0.01] // rad/s: one lap in 5 to 10 minutes

export const expoOut = (t: number): number => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
export const cubicInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

interface Body {
  angle: number
  vel: number // rad/s, for the swing spring
  to: number // where the swing is heading
  moving: boolean
  sel: number // 0..1, eased selection: size, glow and brightness crossfade
  appear: number // entrance 0..1
}

// The swing is a critically damped spring, not a timed ease: it starts
// gently, never overshoots, and pressing again mid-swing retargets it with
// its momentum intact instead of restarting from a standstill. OMEGA sets
// the pace (most of the turn lands in ~0.45 s, settled by ~0.8 s).
const OMEGA = 8.5

export interface Label {
  index: number
  key: string
  x: number // cell
  y: number // cell
  selected: boolean
  live: number
  installed: boolean
}

export class Orrery {
  private bodies: Body[] = []
  private selected = 0
  private clock = 0
  private entrance = 0 // 0..1, orbits drawing on
  /** The core's centre and radius from the last draw, in dot space. */
  core = { x: 0, y: 0, r: 0 }
  private emerge = 1 // 0..1 after a session
  private flare = 0 // corona flare after a session
  private sweep = -1 // >= 0 while an audit runs (angle)
  reduced: boolean

  constructor(count: number, reduced: boolean) {
    this.reduced = reduced
    for (let i = 0; i < count; i++) {
      // Spread the bodies so the first frame already reads as a system.
      const a = FRONT + (i * Math.PI * 2) / count + 0.6 * i
      this.bodies.push({ angle: a, vel: 0, to: a, moving: false, sel: i === 0 ? 1 : 0, appear: reduced ? 1 : 0 })
    }
    this.bodies[0]!.angle = this.bodies[0]!.to = FRONT
    this.entrance = reduced ? 1 : 0
  }

  get animating(): boolean {
    return (
      this.entrance < 1 ||
      this.emerge < 1 ||
      this.flare > 0.01 ||
      this.sweep >= 0 ||
      this.bodies.some((b, i) => b.moving || b.appear < 1 || Math.abs(b.sel - (i === this.selected ? 1 : 0)) > 0.002)
    )
  }

  select(i: number): void {
    if (i === this.selected) return
    this.selected = i
    const sel = this.bodies[i]!
    // The system turns: every body moves by the same forward-wrapped delta,
    // so the chosen one swings to the front and the previous one leaves it.
    // Measured from where the swing is already heading, so quick repeated
    // presses add up instead of fighting the turn in progress.
    let delta = (FRONT - sel.to) % (Math.PI * 2)
    if (delta < 0) delta += Math.PI * 2
    if (delta > Math.PI * 1.5) delta -= Math.PI * 2
    const TAU = Math.PI * 2
    const gap = (a: number) => {
      const d = (((a - FRONT) % TAU) + TAU) % TAU
      return d > Math.PI ? d - TAU : d
    }
    this.bodies.forEach((b, k) => {
      let to = b.to + delta
      if (k !== i) {
        // Keep the front clear for the chosen body.
        const g = gap(to)
        if (Math.abs(g) < 1.0) to += (g >= 0 ? 1 : -1) * (1.0 - Math.abs(g))
      }
      b.to = to
      b.moving = !this.reduced
      if (this.reduced) {
        b.angle = to
        b.vel = 0
      }
    })
  }

  /** The focal moment: after a session the selected body rises out of the core. */
  emergeFromShadow(): void {
    if (this.reduced) return
    this.emerge = 0
    this.flare = 1
  }

  setScanning(on: boolean): void {
    this.sweep = on && !this.reduced ? Math.max(0, this.sweep) : -1
  }

  update(dt: number): void {
    this.clock += dt
    if (this.entrance < 1) this.entrance = Math.min(1, this.entrance + dt / 0.55)
    if (this.emerge < 1) this.emerge = Math.min(1, this.emerge + dt / 0.85)
    this.flare *= Math.exp(-dt * 2.2)
    if (this.sweep >= 0) this.sweep = (this.sweep + dt * 3.2) % (Math.PI * 2)
    this.bodies.forEach((b, i) => {
      if (b.appear < 1) b.appear = Math.min(1, b.appear + dt / (0.45 + i * 0.12))
      const want = i === this.selected ? 1 : 0
      b.sel = this.reduced ? want : b.sel + (want - b.sel) * (1 - Math.exp(-dt * 9))
      if (b.moving) {
        // Substeps keep the spring stable through a slow frame (dt <= 0.1).
        const n = Math.ceil(dt / (1 / 120))
        const h = dt / n
        for (let k = 0; k < n; k++) {
          b.vel += (OMEGA * OMEGA * (b.to - b.angle) - 2 * OMEGA * b.vel) * h
          b.angle += b.vel * h
        }
        if (Math.abs(b.to - b.angle) < 2e-3 && Math.abs(b.vel) < 2e-2) {
          b.angle = b.to
          b.vel = 0
          b.moving = false
        }
      } else if (i !== this.selected && !this.reduced) {
        // Drift, but never into the front window the chosen body owns.
        const next = b.angle + DRIFT[i % DRIFT.length]! * dt
        const d = ((((next - FRONT) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2))
        if (d > 0.9 && d < Math.PI * 2 - 0.9) b.angle = b.to = next
      } else if (i === this.selected) {
        b.angle = b.to = FRONT + Math.round((b.angle - FRONT) / (Math.PI * 2)) * Math.PI * 2
      }
    })
  }

  /**
   * Draws into `cv` within the dot-space rect and returns label anchors in
   * cell coordinates (relative to the canvas).
   */
  draw(
    cv: DotCanvas,
    rect: { x: number; y: number; w: number; h: number },
    theme: Theme,
    state: BodyState[],
    net: string,
    dimmed: number, // 0..1: how far the scene has receded into shadow (reader views)
  ): Label[] {
    const bg = theme.bg
    const shade = (c: RGB, extra = 0): RGB => mix(c, bg, Math.min(0.92, dimmed * 0.62 + extra))
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    // Lean the orbital plane toward the viewer when there is vertical room
    // (wide terminals), flatter when there isn't (tall tiles).
    const flat = Math.max(0.42, Math.min(0.8, (rect.h * 0.44) / (rect.w * 0.46)))
    const extent = Math.hypot(Math.sin(TILT), flat * Math.cos(TILT))
    const rxMax = Math.max(14, Math.min(rect.w * 0.46, (rect.h * 0.45) / extent))
    const coreR = Math.max(5, rxMax * 0.15)
    this.core = { x: cx, y: cy, r: coreR }
    const bodyR = Math.max(3, rxMax * 0.056)
    const ease = cubicInOut(this.entrance)
    const sel = state[this.selected]
    const selInk = sel ? theme.tool[sel.key] ?? theme.fg : theme.fg
    const labels: Label[] = []
    const cellH = 4 * cv.aspect // dot-space units per cell row

    // Faint fixed stars, sparse, for depth only.
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const nStars = Math.floor((rect.w * rect.h) / 900)
    for (let i = 0; i < nStars; i++) {
      const sx = rect.x + rnd() * rect.w
      const sy = rect.y + rnd() * rect.h
      const tw = 0.82 + 0.1 * Math.sin(this.clock * (0.3 + rnd()) + i)
      if (Math.hypot(sx - cx, (sy - cy) * 1.4) < rxMax * 0.6) continue
      cv.dot(sx, sy, shade(mix(theme.hair, bg, tw - 0.5)))
    }

    const orbit = (i: number) => ({ rx: rxMax * ORBIT_K[i]!, ry: rxMax * ORBIT_K[i]! * flat })
    const pos = (i: number, angle: number) => {
      const { rx, ry } = orbit(i)
      const ex = rx * Math.cos(angle)
      const ey = ry * Math.sin(angle)
      return {
        x: cx + ex * Math.cos(TILT) - ey * Math.sin(TILT),
        y: cy + ex * Math.sin(TILT) + ey * Math.cos(TILT),
        depth: (Math.sin(angle) + 1) / 2, // 0 back .. 1 front
      }
    }

    // Back halves of the orbits.
    state.forEach((_, i) => {
      const { rx, ry } = orbit(i)
      cv.ellipse(cx, cy, rx, ry, TILT, shade(theme.hair), { part: "back", frac: ease })
    })

    // Bodies: back ones first (the core will cover them), front ones later.
    const bodies = state.map((s, i) => {
      const b = this.bodies[i]!
      let p = pos(i, b.angle)
      let scale = expoOut(b.appear)
      let behindCore = p.depth < 0.5
      if (i === this.selected && this.emerge < 1) {
        const e = expoOut(this.emerge)
        const front = pos(i, FRONT)
        p = { x: cx + (front.x - cx) * e, y: cy + (front.y - cy) * e, depth: 1 }
        scale *= 0.35 + 0.65 * e
        behindCore = Math.hypot(p.x - cx, p.y - cy) < coreR + bodyR * 0.5
      }
      const r = bodyR * (0.72 + 0.43 * p.depth) * (1 + 0.3 * b.sel) * scale
      return { s, i, p, r, behindCore, sel: b.sel }
    })

    const drawBody = (o: (typeof bodies)[number]) => {
      const ink = theme.tool[o.s.key] ?? theme.fg
      const isSel = o.i === this.selected
      const depthFade = (1 - o.p.depth) * 0.45 + 0.18 * (1 - o.sel)
      if (o.s.installed) {
        if (o.sel > 0.02) cv.glow(o.p.x, o.p.y, o.r * 1.05, o.r * 2.1, shade(ink), bg, 0.2 * o.sel)
        cv.clearFront(o.p.x, o.p.y, o.r)
        cv.disc(o.p.x, o.p.y, o.r, shade(ink, depthFade), bg)
      } else {
        cv.ring(o.p.x, o.p.y, o.r, shade(theme.dim, 0.2), { layer: "front" })
      }
      for (let k = 0; k < Math.min(3, o.s.live); k++) {
        cv.ring(o.p.x, o.p.y, o.r + 2.2 + k * 2, shade(ink, depthFade * 0.6), { layer: "front" })
      }
      const occluded = o.behindCore && Math.hypot(o.p.x - cx, o.p.y - cy) < coreR * 1.1
      if (occluded) return
      labels.push({
        index: o.i,
        key: o.s.key,
        x: Math.round((o.p.x + o.r + 3) / 2),
        y: Math.round(o.p.y / cellH),
        selected: isSel,
        live: o.s.live,
        installed: o.s.installed,
      })
    }

    bodies.filter((o) => o.behindCore).sort((a, b) => a.p.depth - b.p.depth).forEach(drawBody)

    // The sealed core and its corona (in the selected tool's ink).
    const breathe = 0.5 + 0.5 * Math.sin(this.clock * 0.9)
    const coronaStrength = (0.34 + 0.1 * breathe + 0.55 * this.flare) * ease
    cv.glow(cx, cy, coreR * 0.95, coreR * (1.9 + 0.5 * this.flare), shade(selInk), bg, coronaStrength)
    cv.disc(cx, cy, coreR * (0.6 + 0.4 * ease), theme.core, bg)

    // The egress halo for the selected tool.
    const haloR = coreR * 1.55
    const halo = shade(theme.halo, 0.15)
    const phase = this.clock * 6
    if (ease > 0.6) {
      if (net === "ask") cv.ring(cx, cy, haloR, halo, { dash: [3, 4], phase, layer: "front" })
      else if (net === "strict") cv.ring(cx, cy, haloR, halo, { dash: [1, 2], layer: "front" })
      else if (net === "open") cv.ring(cx, cy, haloR, mix(halo, bg, 0.5), { layer: "front" })
      else if (net === "host") cv.ring(cx, cy, haloR, halo, { gap: 1.4, gapAt: Math.PI / 2, layer: "front" })
    }

    // Front halves of the orbits, then the near bodies.
    state.forEach((_, i) => {
      const { rx, ry } = orbit(i)
      cv.ellipse(cx, cy, rx, ry, TILT, shade(mix(theme.hair, theme.fg, 0.22)), { part: "front", frac: ease })
    })
    bodies.filter((o) => !o.behindCore).sort((a, b) => a.p.depth - b.p.depth).forEach(drawBody)
    // The audit sweep rides the halo ring on top of everything, running
    // clockwise so its tail trails away from the body at the front.
    if (this.sweep >= 0) {
      const rr = coreR * 1.55
      for (let k = 0; k < 30; k++) {
        const a = -this.sweep + k * 0.05
        const px = cx + rr * Math.cos(a)
        const py = cy + rr * Math.sin(a)
        cv.clearFront(px, py, 0.4)
        cv.dot(px, py, mix(selInk, bg, (k / 30) ** 1.3), "front")
      }
    }
    // A label never sits on another body's disc.
    return labels.filter((l) => {
      const len = l.key.length + (l.live ? 8 : 0)
      return !bodies.some((o) => {
        if (o.i === l.index) return false
        const bx0 = (o.p.x - o.r) / 2
        const bx1 = (o.p.x + o.r) / 2
        const by0 = (o.p.y - o.r) / cellH
        const by1 = (o.p.y + o.r) / cellH
        return l.y >= Math.floor(by0) && l.y <= Math.ceil(by1) && l.x <= bx1 && l.x + len >= bx0
      })
    })
  }

  /**
   * Tiny terminals: the same system seen edge-on, one row tall. A braille
   * hairline is the orbit, the core a dark mark with its corona, and bodies
   * slide along it by orbital angle; near bodies pass in front of the core.
   * Returns the cell column of the selected body.
   */
  drawStrip(cv: DotCanvas, theme: Theme, state: BodyState[]): number {
    const bg = theme.bg
    const w = cv.width
    const cx = w / 2
    const cy = 2
    const rx = w / 2 - 4
    const sel = state[this.selected]
    const selInk = sel ? theme.tool[sel.key] ?? theme.fg : theme.fg
    for (let x = 2; x < w - 2; x += 2) cv.dot(x, cy, mix(theme.hair, theme.fg, 0.1))
    const items = state.map((s, i) => {
      const b = this.bodies[i]!
      const k = ORBIT_K[i]!
      return { s, i, x: cx + rx * k * Math.cos(b.angle), depth: (Math.sin(b.angle) + 1) / 2 }
    })
    const body = (o: (typeof items)[number]) => {
      const ink = theme.tool[o.s.key] ?? theme.fg
      cv.disc(o.x, cy, o.i === this.selected ? 2.2 : 1.5, mix(ink, bg, (1 - o.depth) * 0.45), bg)
    }
    items.filter((o) => o.depth < 0.5).forEach(body)
    cv.glow(cx, cy, 2.4, 6, selInk, bg, 0.35 + 0.1 * Math.sin(this.clock * 0.9) + 0.4 * this.flare)
    cv.disc(cx, cy, 2.6, theme.core, bg)
    items.filter((o) => o.depth >= 0.5).sort((a, b) => a.depth - b.depth).forEach(body)
    const s = items.find((o) => o.i === this.selected)
    return s ? Math.round(s.x / 2) : 0
  }

  /** Which body (index) is under the cell (col,row), for mouse selection. */
  hit(labels: Label[], col: number, row: number): number {
    let best = -1
    let bestD = 4
    for (const l of labels) {
      const d = Math.abs(l.y - row) + Math.abs(l.x - 2 - col) / 3
      if (d < bestD) {
        bestD = d
        best = l.index
      }
    }
    return best
  }
}
