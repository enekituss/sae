#!/usr/bin/env python3
"""Genera iconos PNG PWA sin dependencias externas."""
import struct
import zlib
from pathlib import Path


def make_png(size, path):
    pixels = bytearray([23, 33, 43] * size * size)

    def put(x, y, color):
        if 0 <= x < size and 0 <= y < size:
            index = (y * size + x) * 3
            pixels[index:index+3] = bytes(color)

    def rect(x1, y1, x2, y2, color, radius=0):
        x1, y1, x2, y2 = [int(round(v * size)) for v in (x1, y1, x2, y2)]
        r = int(round(radius * size))
        for y in range(max(0, y1), min(size, y2)):
            for x in range(max(0, x1), min(size, x2)):
                if r:
                    cx = min(max(x, x1+r), x2-r-1)
                    cy = min(max(y, y1+r), y2-r-1)
                    if (x-cx)**2 + (y-cy)**2 > r*r:
                        continue
                put(x, y, color)

    def circle(cx, cy, radius, color):
        cx, cy, radius = [int(round(v * size)) for v in (cx, cy, radius)]
        rr = radius * radius
        for y in range(max(0, cy-radius), min(size, cy+radius+1)):
            dy = y - cy
            for x in range(max(0, cx-radius), min(size, cx+radius+1)):
                dx = x - cx
                if dx*dx + dy*dy <= rr:
                    put(x, y, color)

    white = (255, 255, 255)
    orange = (242, 140, 0)
    light = (220, 229, 236)
    # Carrocería, ventanas, paragolpes y ruedas.
    rect(.16, .18, .84, .70, white, .075)
    rect(.21, .24, .47, .42, orange, .025)
    rect(.53, .24, .79, .42, orange, .025)
    rect(.21, .46, .79, .58, light, .025)
    rect(.20, .63, .80, .68, orange, .015)
    circle(.30, .73, .075, white)
    circle(.70, .73, .075, white)
    circle(.30, .73, .033, orange)
    circle(.70, .73, .033, orange)
    rect(.24, .84, .76, .875, orange, .015)

    raw = bytearray()
    stride = size * 3
    for y in range(size):
        raw.append(0)
        raw.extend(pixels[y*stride:(y+1)*stride])

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

    header = struct.pack(">2I5B", size, size, 8, 2, 0, 0, 0)
    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(image)
    print(f"Creado {path} ({len(image):,} bytes)")


if __name__ == "__main__":
    make_png(192, "icon-192.png")
    make_png(512, "icon-512.png")
