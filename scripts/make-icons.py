#!/usr/bin/env python3
"""Generates the extension icons (icons/icon-{16,32,48,128}.png).

No dependencies: draws with 4x supersampling and writes PNG with zlib.
Run: python3 scripts/make-icons.py
"""
import os
import struct
import zlib

BG = (139, 26, 43)        # deep red
PAGE = (255, 255, 255)
LINE = (139, 26, 43)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(u, v):
    """u, v in [0, 1). Returns RGBA."""
    if not inside_round_rect(u, v, 0.0, 0.0, 1.0, 1.0, 0.2):
        return (0, 0, 0, 0)
    # One tall page, standing for every page joined into one.
    if inside_round_rect(u, v, 0.27, 0.14, 0.73, 0.86, 0.05):
        for i in range(6):
            top = 0.24 + i * 0.1
            right = 0.63 if i % 3 != 2 else 0.53
            if inside_round_rect(u, v, 0.37, top, right, top + 0.035, 0.015):
                return LINE + (255,)
        return PAGE + (255,)
    return BG + (255,)


def render(size, ss=4):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    r, g, b, a = color_at((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            alpha = acc[3] / n
            if alpha:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    return b''.join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        with open(os.path.join(out_dir, f'icon-{size}.png'), 'wb') as f:
            f.write(png(size, render(size)))
        print(f'icons/icon-{size}.png')


if __name__ == '__main__':
    main()
