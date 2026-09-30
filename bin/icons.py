#!/usr/bin/env python3
"""Draw the toolbar icons (stdlib only): an ink tile, a plate rim, a coral strike. → icons/*.png"""
import math, struct, zlib
from pathlib import Path

INK, PAPER, CORAL = (11, 12, 14), (233, 230, 222), (224, 122, 107)
OUT = Path(__file__).resolve().parent.parent / "icons"


def sd_round_rect(x, y, half, r):
    qx, qy = abs(x) - half + r, abs(y) - half + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def sd_segment(x, y, ax, ay, bx, by):
    px, py, dx, dy = x - ax, y - ay, bx - ax, by - ay
    t = max(0, min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - dx * t, py - dy * t)


def shade(x, y):
    """x, y in [-1, 1]. Returns (rgb, alpha)."""
    if sd_round_rect(x, y, 1.0, 0.44) > 0:
        return None
    ring = abs(math.hypot(x, y) - 0.52) - 0.085
    k = 0.5 / math.sqrt(2)
    strike = sd_segment(x, y, -0.62, -0.62, 0.62, 0.62) - 0.10
    if strike <= 0:
        return CORAL
    if ring <= 0:
        return PAPER
    return INK


def png(size, path, ss=6):
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    x = ((i + (si + 0.5) / ss) / size) * 2 - 1
                    y = ((j + (sj + 0.5) / ss) / size) * 2 - 1
                    c = shade(x, y)
                    if c:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a:
                row += bytes([round(acc[0] * 255 / acc[3]), round(acc[1] * 255 / acc[3]), round(acc[2] * 255 / acc[3]), round(a)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    path.write_bytes(data)


OUT.mkdir(exist_ok=True)
for s in (16, 32, 48, 128):
    png(s, OUT / f"{s}.png")
print("icons:", ", ".join(sorted(p.name for p in OUT.glob("*.png"))))
