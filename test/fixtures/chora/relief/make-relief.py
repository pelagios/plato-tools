"""Write relief-fixture.pmtiles: a small stand-in for the shaded relief (src/chora/relief.js) for the browser checks,
which never fetch the real one. PMTiles version 3, grey WebP tiles of 256 pixels as the real file has, zooms 0 to 7
over the Aegean (19° E to 29° E, 34° N to 42° N), each tile the same three greys, so that a probe of the map knows
what it should find wherever it looks: its left half flat (182, as the real file's flat ground decodes), its upper
right quarter in shadow (60), its lower right quarter lit (235).

    python3 test/fixtures/chora/relief/make-relief.py      (Pillow, with WebP; run from the repository's root)

The PMTiles writer is this file's own, a few lines: a header, one root directory (no leaf directories, not
compressed), the metadata, the tiles (one copy of the tile, as every tile is the same, addressed by every entry)."""
import io, json, math, pathlib, struct
from PIL import Image

OUT = pathlib.Path(__file__).with_name('relief-fixture.pmtiles')
BOUNDS = (19.0, 34.0, 29.0, 42.0)
ZOOMS = range(0, 8)

def tile_bytes():
    im = Image.new('L', (256, 256), 182)
    for y in range(256):
        for x in range(128, 256):
            im.putpixel((x, y), 60 if y < 128 else 235)
    buf = io.BytesIO(); im.convert('RGB').save(buf, 'WEBP', lossless=True); return buf.getvalue()

def zxy_to_id(z, x, y):
    acc = sum(4 ** i for i in range(z))
    n, d, rx, ry, xx, yy = 2 ** z, 0, 0, 0, x, y
    s = n // 2
    while s > 0:
        rx = 1 if (xx & s) > 0 else 0
        ry = 1 if (yy & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1: xx, yy = s - 1 - xx, s - 1 - yy
            xx, yy = yy, xx
        s //= 2
    return acc + d

def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)

def tiles_in(z):
    n = 2 ** z
    tx = lambda lon: int((lon + 180) / 360 * n)
    ty = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    w, s, e, nn = BOUNDS
    return [(z, x, y) for x in range(tx(w), min(n - 1, tx(e)) + 1) for y in range(ty(nn), min(n - 1, ty(s)) + 1)]

data = tile_bytes()
ids = sorted(zxy_to_id(*t) for z in ZOOMS for t in tiles_in(z))
# Every entry points at the one copy of the tile (offset 0, its length): run length 1 each.
directory = varint(len(ids))
last = 0
for i in ids: directory += varint(i - last); last = i
directory += b''.join(varint(1) for _ in ids)
directory += b''.join(varint(len(data)) for _ in ids)
directory += varint(1) + b''.join(varint(1) for _ in ids[1:])   # offset 0 for the first (written +1), then the same offset again: 1 (= 0 + 1)
meta = json.dumps({'name': 'relief fixture', 'attribution': 'Shaded relief from NASA SRTM (public domain); USGS GMTED2010 (public domain)', 'description': 'A fixture for the browser checks: every tile the same.'}).encode()
root_off = 127; meta_off = root_off + len(directory); data_off = meta_off + len(meta)
header = b'PMTiles' + bytes([3]) + struct.pack('<QQQQQQQQQQQ', root_off, len(directory), meta_off, len(meta), 0, 0, data_off, len(data), len(ids), len(ids), 1)
header += bytes([0, 1, 1, 4, min(ZOOMS), max(ZOOMS)])                 # not clustered; no internal compression; tiles not compressed; WebP
header += struct.pack('<iiii', *[round(v * 1e7) for v in BOUNDS])
header += bytes([4]) + struct.pack('<ii', round(24 * 1e7), round(38 * 1e7))
assert len(header) == 127, len(header)
OUT.write_bytes(header + directory + meta + data)
print(OUT, OUT.stat().st_size, 'bytes,', len(ids), 'tiles')
