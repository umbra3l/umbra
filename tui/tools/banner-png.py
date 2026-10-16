#!/usr/bin/env python3
"""Rasterises an ANSI frame from tools/banner.ts the way kitty draws it: a
fixed cell grid in JetBrains Mono, with half-blocks and braille drawn
procedurally (pixel-exact, like kitty's box-drawing renderer) instead of from
the font. Draws at SS times the output size, then downsamples, so dots and
type are anti-aliased.

  python3 -I tools/banner-png.py banner-dark.ansi ../docs/banner-dark.png [scale]
"""
import re, sys
from PIL import Image, ImageDraw, ImageFont

src, dst = sys.argv[1:3]
SCALE = float(sys.argv[3]) if len(sys.argv) > 3 else 2   # output pixels per kitty pixel
SS = 3                                                    # supersampling
K = SCALE * SS
CW, CH = round(9 * K), round(19 * K)                      # JetBrains Mono 11pt cell in kitty
FONTS = "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-"
REG = ImageFont.truetype(FONTS + "Regular.ttf", round(15 * K))
BLD = ImageFont.truetype(FONTS + "Bold.ttf", round(15 * K))
DOT = 1.25 * K                                            # braille dot radius

rows = []
for line in open(src, encoding="utf-8").read().split("\n"):
    fg = bg = (0, 0, 0)
    bold = False
    cells = []
    for m in re.finditer(r"\x1b\[([0-9;]*)m|([^\x1b]+)", line):
        if m.group(2) is not None:
            cells += [(ch, fg, bg, bold) for ch in m.group(2)]
            continue
        ps = [int(x) if x else 0 for x in m.group(1).split(";")]
        k = 0
        while k < len(ps):
            p = ps[k]
            if p == 0: bold = False
            elif p == 1: bold = True
            elif p in (38, 48) and ps[k + 1] == 2:
                c = tuple(ps[k + 2:k + 5]); k += 4
                if p == 38: fg = c
                else: bg = c
            k += 1
    if cells: rows.append(cells)

W = max(len(r) for r in rows)
img = Image.new("RGB", (W * CW, len(rows) * CH))
d = ImageDraw.Draw(img)
BR = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
for y, r in enumerate(rows):
    for x, (ch, fg, bg, bold) in enumerate(r):
        X, Y = x * CW, y * CH
        d.rectangle([X, Y, X + CW - 1, Y + CH - 1], fill=bg)
        o = ord(ch)
        if ch == " ":
            continue
        if ch == "▀":
            d.rectangle([X, Y, X + CW - 1, Y + CH // 2 - 1], fill=fg)
        elif 0x2800 <= o <= 0x28FF:
            for i, (bx, by) in enumerate(BR):
                if (o - 0x2800) & (1 << i):
                    cx = X + (bx * 2 + 1) * CW / 4
                    cy = Y + (by * 2 + 1) * CH / 8
                    d.ellipse([cx - DOT, cy - DOT, cx + DOT, cy + DOT], fill=fg)
        elif ch in "┌┐└┘─":
            t = max(1, round(K))
            mx, my = X + CW // 2, Y + CH // 2
            if ch in "─┌└": d.rectangle([mx if ch != "─" else X, my, X + CW, my + t - 1], fill=fg)
            if ch in "─┐┘": d.rectangle([X, my, mx + t - 1 if ch != "─" else X + CW, my + t - 1], fill=fg)
            if ch in "┌┐": d.rectangle([mx, my, mx + t - 1, Y + CH], fill=fg)
            if ch in "└┘": d.rectangle([mx, Y, mx + t - 1, my + t - 1], fill=fg)
        else:
            d.text((X, Y + K), ch, font=BLD if bold else REG, fill=fg)

out = img.resize((round(img.width / SS), round(img.height / SS)), Image.LANCZOS)
out.save(dst, optimize=True)
print(dst, out.size)
