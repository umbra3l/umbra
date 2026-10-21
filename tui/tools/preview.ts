// Renders the REAL UI headlessly (opentui's test renderer) to an ANSI frame,
// so layout and the nebula can be judged at any size, with or without the
// pointer stirring it. tools/banner-png.py rasterises the frame.
//   bun tools/preview.ts <cols> <rows> [seconds] [pointerX pointerY [click]]  > out.ansi

import { createTestRenderer } from "@opentui/core/testing"
import { main } from "../src/app"

const [W, H, secs] = [Number(process.argv[2] ?? 160), Number(process.argv[3] ?? 48), Number(process.argv[4] ?? 6)]
const px = process.argv[5] !== undefined ? Number(process.argv[5]) : null
const py = Number(process.argv[6] ?? 0)
const click = process.argv[7] === "click"

// A fake clock: every frame advances exactly 1/30 s, however long it takes.
let now = 0
performance.now = () => now
const { renderer, renderOnce, mockMouse, captureSpans } = await createTestRenderer({ width: W, height: H, useMouse: true })
// Report kitty's JetBrains Mono cell (9 x 19 px, what banner-png.py draws),
// so the orrery's aspect correction matches the rasterised preview.
Object.defineProperty(renderer, "resolution", { get: () => ({ width: renderer.width * 9, height: renderer.height * 19 }) })
await main(renderer)
const frames = Math.round(secs * 30)
for (let f = 0; f < frames; f++) {
  now += 1000 / 30
  // The pointer arrives in the last second, sweeping in from the left.
  if (px !== null && f >= frames - 30) {
    const k = (f - (frames - 30)) / 29
    await mockMouse.moveTo(Math.round(px - 24 * (1 - k)), Math.round(py + 6 * (1 - k)))
    if (click && f === frames - 12) await mockMouse.click(px, py)
  }
  await renderOnce()
}
const sgr = (c: { toInts(): number[] }) => c.toInts().slice(0, 3).join(";")
let out = ""
for (const line of captureSpans().lines) {
  for (const s of line.spans) out += `\x1b[0;${s.attributes & 1 ? "1;" : ""}38;2;${sgr(s.fg)};48;2;${sgr(s.bg)}m${s.text}`
  out += "\x1b[0m\n"
}
process.stdout.write(out)
process.exit(0)
