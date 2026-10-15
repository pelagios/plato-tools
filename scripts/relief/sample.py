"""Render tiles to PNG mosaics from an MBTiles file, or from a PMTiles archive
(local path or http URL, read through the pmtiles CLI, i.e. by range requests).
usage: sample.py file.mbtiles|file.pmtiles|URL outdir name:z:lon:lat:n ...
env PMTILES: path to the pmtiles CLI."""
import io, math, os, sqlite3, subprocess, sys
from PIL import Image
src = sys.argv[1]; out = sys.argv[2]
PM = src.endswith(".pmtiles")
db = None if PM else sqlite3.connect(src)
def get(z, x, y):
    if PM:
        r = subprocess.run([os.environ.get("PMTILES", "pmtiles"), "tile", src, str(z), str(x), str(y)],
                           capture_output=True)
        return r.stdout if r.returncode == 0 and r.stdout else None
    r = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                   (z, x, 2 ** z - 1 - y)).fetchone()
    return r[0] if r else None
for spec in sys.argv[3:]:
    name, z, lon, lat, n = spec.split(":"); z, n = int(z), int(n); lon, lat = float(lon), float(lat)
    N = 2 ** z; cx = int((lon + 180) / 360 * N)
    cy = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N)
    m = Image.new("L", (256 * n, 256 * n), 0); got = 0
    for i in range(n):
        for j in range(n):
            x, y = cx - n // 2 + i, cy - n // 2 + j
            d = get(z, x, y)
            if d: m.paste(Image.open(io.BytesIO(d)).convert("L"), (i * 256, j * 256)); got += 1
    m.save(f"{out}/{name}.png"); print(name, f"z{z}", f"{got}/{n*n} tiles")
