import { RGBA } from "@opentui/core"

export type RGB = readonly [number, number, number]

export function hex(h: string): RGB {
  const s = h.replace("#", "")
  return [Number.parseInt(s.slice(0, 2), 16), Number.parseInt(s.slice(2, 4), 16), Number.parseInt(s.slice(4, 6), 16)]
}

/** mix(a, b, t): t = 0 gives a, t = 1 gives b. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(c: RGB): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Moves c toward `toward` until it reaches `ratio` contrast against bg. */
export function ensureContrast(c: RGB, bg: RGB, toward: RGB, ratio: number): RGB {
  if (contrast(c, bg) >= ratio) return c
  for (let t = 0.05; t <= 1; t += 0.05) {
    const m = mix(c, toward, t)
    if (contrast(m, bg) >= ratio) return m
  }
  return toward
}

// RGBA objects are cached by packed value: a frame touches thousands of
// cells but only a few hundred distinct colours.
const cache = new Map<number, RGBA>()
export function rgba(c: RGB): RGBA {
  const r = Math.round(c[0]) & 255
  const g = Math.round(c[1]) & 255
  const b = Math.round(c[2]) & 255
  const key = (r << 16) | (g << 8) | b
  let v = cache.get(key)
  if (!v) {
    if (cache.size > 4096) cache.clear()
    v = RGBA.fromInts(r, g, b, 255)
    cache.set(key, v)
  }
  return v
}
