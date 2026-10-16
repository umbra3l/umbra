---
name: umbra
description: A terminal launcher where your AI tools orbit a sealed core, drawn entirely in the terminal's own palette.
colors:
  night: "#141414"
  ink-fg: "#C6C3C3"
  ink-dim: "#92908F"
  hair: "#464545"
  hair-front: "#626161"
  core: "#080808"
  tool-claude: "#FF98AB"
  tool-opencode: "#65C1EC"
  tool-agy: "#73C791"
  halo: "#CDA6F6"
  warn: "#C4B84E"
  danger: "#FF98AB"
  ok: "#73C791"
typography:
  display:
    fontFamily: "URW Gothic Demi, baked to half-block coverage bitmaps"
    fontSize: "4 to 12 rows (8 to 24 half-block pixels tall)"
    fontWeight: 600
    lineHeight: 1
  title:
    fontFamily: "terminal monospace (inherited)"
    fontSize: "1 cell"
    fontWeight: 700
    lineHeight: 1
  body:
    fontFamily: "terminal monospace (inherited)"
    fontSize: "1 cell"
    fontWeight: 400
    lineHeight: 1
  label:
    fontFamily: "terminal monospace (inherited)"
    fontSize: "1 cell"
    fontWeight: 400
    lineHeight: 1
rounded:
  none: "0"
spacing:
  margin: "2 cells"
  key-to-label: "3 cells"
  label-to-hint: "4 cells"
  column-gutter: "4 cells"
  block-gap: "1 row"
components:
  action-pill:
    backgroundColor: "{colors.tool-claude}"
    textColor: "{colors.night}"
    rounded: "{rounded.none}"
    padding: "0 1 cell"
    height: "1 row"
  action-row:
    textColor: "{colors.ink-fg}"
    height: "1 row"
  action-row-disabled:
    textColor: "{colors.ink-dim}"
    height: "1 row"
  status-line:
    textColor: "{colors.ink-dim}"
    height: "1 row"
  header:
    textColor: "{colors.ink-fg}"
    height: "1 row"
---

# Design System: umbra

## Overview

**Creative North Star: "The Orrery in the Umbra"**

The terminal's own background is the night. On it, a black core sits inside a corona coloured by the selected tool, ringed by a dotted halo that is the egress mode, and three tilted braille orbits carry one body per tool. Choosing a tool turns the whole system so its body swings to the front; launching sends it into the shadow, and when the session ends it re-emerges from behind the core. Every mark on screen is real state. Positions along the orbits are the one exception: they only keep the system alive.

The system owns no colours. Every role is an ANSI palette slot read live through OSC 4/10/11 queries and re-read on the terminal's `palette` event, so the scene follows the user's wallpaper. The hex values in the frontmatter are the FALLBACK palette in `theme.ts`, used only when the terminal stays silent; treat them as examples of a resolved theme, never as the identity. A contrast floor (`ensureContrast` in `color.ts`) pulls any slot toward the foreground until it clears its role's ratio against the background.

Density is low and type-led: one large word, a short facts block, seven or eight keyed actions, a status line. Regions have no boxes. A region is marked only by four corner registration ticks.

**Key Characteristics:**
- Palette roles, not colours: every ink is an ANSI index with a contrast floor.
- One large thing on screen: the selected tool's name in baked display type.
- Hairline braille orbits at one weight; solid shapes in anti-aliased half-blocks.
- Registration ticks instead of boxes.
- Damped, single-axis motion that never delays a launch.

## Colors

A borrowed palette: three tool inks, one halo ink, one warning ink, and a neutral ladder derived from the terminal's background and foreground.

### Primary
- **Tool Inks** (`tool-claude` = ANSI 1, `tool-opencode` = ANSI 4, `tool-agy` = ANSI 2; contrast floor 3:1): each tool wears its slot. The selected tool's ink paints its body, the corona, the display name, the focused pill, the header dot, the status-line diamond and the audit sweep. Unselected tools show their ink only on their own body and "live" note.

### Secondary
- **Halo Violet** (`halo` = ANSI 5, floor 3:1): the egress halo ring and the egress mode word in the header. Its meaning is egress, nothing else.

### Tertiary
- **Signal Inks** (`warn` = ANSI 3, `danger` = ANSI 1, `ok` = ANSI 2, floor 3:1): used only inside reader views and session summaries. ok marks ALLOW, added files and passed checks; danger marks DENY, deleted files and failures; warn marks prompts, host-executed files and the ▲ warning line. Note that danger shares slot 1 with claude, and ok shares slot 2 with agy: meaning comes from the reader context, never from the hue alone.

### Neutral
- **Night** (`night` = OSC 11 default background, else ANSI 0): every cell's background. Light terminals are detected (luminance at or above 0.35) and the ladder below inverts its mixes.
- **Foreground Ink** (`ink-fg` = OSC 10 default foreground, else ANSI 15; floor 7:1): names, action labels, path, key letters in the hint bar.
- **Dim Ink** (`ink-dim` = ANSI 8, floor 4.5:1): versions, hints, facts, rest-state key letters, label text beside unselected bodies, the version after the mark.
- **Hair** (`hair` = night mixed 28% toward fg, 35% on light themes): back halves of orbits, registration ticks, stars. Never text.
- **Front Hair** (`hair-front` = hair mixed 22% toward fg): front halves of orbits, so the near side of the plane reads nearer.
- **Core** (`core` = night mixed 60% toward black; on light themes fg mixed 12% toward bg): the sealed core, the deepest value on screen.

### Named Rules
**The Borrowed Palette Rule.** Never write a literal colour. Every ink is an ANSI slot or a mix of night, fg and black, resolved at runtime and re-resolved when the palette changes.

**The Floor Rule.** Inks clear 3:1, dim clears 4.5:1, fg clears 7:1 against night; `ensureContrast` moves the slot toward fg in 5% steps until it does.

**The One Meaning Rule.** Halo violet means egress; yellow means real risk. Neither appears as decoration.

## Typography

**Display Font:** URW Gothic Demi (URW base35), pre-rasterised by `tools/bake-type.py` into coverage bitmaps for the three tool names only, drawn as `▀` half-blocks with colour-blended edges.
**Body Font:** the terminal's own monospace, inherited, never chosen.

**Character:** a round geometric display word set against plain terminal text; hierarchy is scale contrast and weight, nothing else.

### Hierarchy
- **Display** (Gothic Demi, 8 baked sizes from 4 to 12 rows): the selected tool's name, at the largest size that fits the text column (up to 20% of its height in wide, 26% in stack). Not drawn in tiny.
- **Title** (bold, 1 cell): the product mark `umbra`, the tool's full name under the display word, the reader title, the focused pill label, reader verdict columns.
- **Body** (regular, 1 cell, fg): action labels, paths, reader content.
- **Label** (regular, 1 cell, dim): versions, hints, facts, the right side of the header, words in the key-hint bar.

### Named Rules
**The One Large Word Rule.** Only the selected tool's name is display-sized. Everything else is one cell tall.

**The Inherited Face Rule.** Body text uses whatever font the terminal uses; the system never asks for a face it cannot see.

## Layout

The grid is the cell grid. Drawing inside the orrery happens in dot space (2 by 4 dots per cell, roughly square pixels); fills use half-blocks (1 by 2 per cell).

- **Wide** (width at least 118 and width/height at least 1.85): header row; orrery at the left 52% inside registration ticks; text column 4 cells right of it, vertically centred against its space; status line at the bottom.
- **Stack** (tall tiles): orrery on top, up to 44% of the height (max 30 rows), keeping about 15 rows for name, facts and actions; text column below it inset 4 cells, placed 30% into its free space.
- **Tiny** (width under 64, height under 20, or an orrery under 9 rows): the system seen edge-on as a one-row strip under the header, with the selected tool's name beside it in bold ink; the text block follows with the full name as a bold title.
- **Rows**: header and status line sit on the first and second-last rows when the height is at least 32, on the edge rows otherwise. Outer margin is 2 cells.
- **Action rows**: key letter, 3 cells to the label, 4 cells to the hint. Over-long text ends in `…`; hints drop out before labels do.
- **Reader views** take the text column from the block's top and keep it there; they do not centre.

## Elevation & Depth

There are no shadows and no layers of panels. Depth lives inside the orrery alone and is conveyed by the scene's own optics: the back halves of orbits are drawn first in hair and hidden by the core; bodies behind the core are drawn before it; front halves in front hair and near bodies come last, each body clearing the hairline dots under it. Bodies shrink and fade toward night with depth (up to 45%, plus 18% when unselected). Glow is light, not lift: the corona around the core, and a soft glow on the selected body.

When a reader view opens, the whole scene recedes into shadow, mixed up to 62% toward night, while labels fade 60%.

### Named Rules
**The Two Glows Rule.** Only the corona and the selected body glow. Unselected bodies, rings and text never do.

**The Front Window Rule.** The front of the orbits belongs to the selected body. Other bodies are pushed out of a 1-radian window on selection and never drift into a 0.9-radian window at rest.

## Shapes

The form language is the orrery's: filled discs (core, bodies), ellipses (orbits, tilted −0.24 rad), rings (halo, live-session rings, the hollow body of an uninstalled tool), and single dots (stars, the strip, the sweep). Every edge is anti-aliased by 4x4 supersampling and colour-blended into night.

Outside the scene there are no shapes at all, only text and one flat rectangle, the focused pill (square cell corners). Regions are marked by `┌─ ─┐ └─ ─┘` registration ticks in hair at the orrery's four corners.

**The No Box Rule.** No borders, frames or panels. A region is announced by four corner ticks or by nothing.

## Components

### The Orrery (signature)
A black core with a breathing corona (strength 0.34 + 0.10 breathing at 0.9 rad/s, plus a flare after a session that decays at 2.2/s) in the selected tool's ink; an egress halo at 1.55 core radii; three orbits at 0.66, 0.84 and 1.0 of the outer radius, flattened between 0.34 and 0.6 depending on room. One body per tool; the selected body is 1.3 times larger.
- **Halo modes**: ask is a dashed ring (3 on, 4 off) slowly turning; strict a tight dotted ring (1 on, 2 off), still; open one faint solid ring at half strength; host a ring opened toward the viewer; none draws no halo.
- **Body states**: installed is a filled disc; not installed a hollow ring in dim with "not installed" on its label; each live session adds a ring (up to three).
- **Labels**: the tool key beside its body, bold in ink when selected, dim otherwise; hidden when the core occludes the body or when it would sit on another body.
- **Select**: the whole system turns by one shared forward delta so the chosen body reaches the front; others are nudged clear of the front window. Swing is 600 ms exponential ease-out.
- **Emerge**: after any VM hand-off, the selected body rises from the core to the front over 850 ms, growing from 35% scale, while the corona flares.
- **Audit sweep**: while an audit runs, a 30-dot clockwise comet in the selected ink rides the halo ring on top of everything, its tail fading to night.
- **Idle**: unselected bodies drift (one lap in 5 to 10 minutes); stars twinkle faintly.

### Orbit Strip (tiny)
The same system edge-on: a dotted hairline (hair 10% toward fg), the core with its corona at the centre, bodies sliding along by orbital angle, near ones passing in front of the core.

### Action List
- **Rest**: dim key letter, fg label, dim hint.
- **Focused**: a flat pill in the tool's ink from one cell left of the key to 6 cells past the label; key and label bold in night on the pill. The pill glides between rows (exponential approach, rate 26/s).
- **Pressed**: on Enter the pill flashes toward fg (45%) for 40 ms, then the tool takes the terminal. The flash never extends the hand-off.
- **Disabled**: label struck through in dim; the hint carries the reason ("no snapshot yet", "not installed").
- **Keys**: ⏎ launch, s shell, i sign in, d changes, u undo, e egress, a audit, r refresh models (opencode only).

### Facts Block
Full name (bold fg), version and concurrency (dim); a ● live line in the tool's ink when sessions run; a ◇ dim line when no project is mounted; or the last-session line, held 0.3 s after return and then faded in over 0.6 s, with a ▲ warn line naming host-executed files that changed.

### Reader Views
Egress log, last session's changes and security audit slide in from 6 cells right on one axis as the action list slides 4 cells left and fades. Bold fg title, a braille spinner with "running" in tool ink while streaming, then rows of coloured spans. The egress reader prints time and tool once per run of identical values, leaving the verdict and host as the scanned column. A dim "n–m of N" range appears when the content scrolls.

### Header and Status Line
Header: a ● in tool ink, `umbra` bold, `v2.0` dim; on the right "egress" dim, the mode bold in halo, then vCPU and RAM dim. Status line: ◆ in tool ink, the project path in fg (dim when not mounted), branch and snapshots dim, other tools' live sessions in their own ink; on the right the key hints with keys in fg and words in dim.

## Do's and Don'ts

### Do:
- **Do** take every ink from an ANSI slot through `buildTheme`, and re-read it on the palette event.
- **Do** mark regions with corner registration ticks in hair.
- **Do** keep motion on one axis and damped: exponential ease-out for swings and slides, cubic in-out only for the orbits drawing on (550 ms).
- **Do** honour `UMBRA_REDUCED_MOTION=1`: every transition becomes instant and the loop drops to 12 fps.
- **Do** tie every mark to real state; if a mark has no state behind it, it goes.

### Don't:
- **Don't** draw boxes, borders or framed panels around any region.
- **Don't** set a second word in display type, or use display type outside the three baked tool names.
- **Don't** use halo violet or warn yellow for anything but egress and real risk.
- **Don't** let any animation delay Enter: launch is the main act.
- **Don't** go hacker cliché: no neon green, glitch, matrix rain or "cyber" styling.
