#!/usr/bin/env python3
"""Two 256×256 PNGs for the e2e page: one carrying an IPTC 'trainedAlgorithmicMedia' XMP
label (what OpenAI / Google / Adobe write into generated images), one with no label."""
import struct, zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "test/pages"
XMP = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" '
    'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>'
    "</rdf:RDF></x:xmpmeta>"
)


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def png(path, rgb, xmp=None, size=256):
    rows = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    parts = [b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))]
    if xmp:
        parts.append(chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + xmp.encode()))
    parts += [chunk(b"IDAT", zlib.compress(rows, 9)), chunk(b"IEND", b"")]
    path.write_bytes(b"".join(parts))


OUT.mkdir(parents=True, exist_ok=True)
png(OUT / "labelled.png", (200, 120, 110), XMP)
png(OUT / "plain.png", (110, 140, 200))
print("wrote", OUT / "labelled.png", OUT / "plain.png")
