"""Cut an aligned 3857 Byte hillshade (from grid.py) into 256 px WebP tiles in
an MBTiles file. Identical tiles (flat sea) are stored once in the images table.
usage: tile.py hillshade.tif zoom x0 y0 nx ny out.mbtiles quality procs
Optionally a tone curve: env RELIEF_GAMMA (default 1)."""
import hashlib, io, os, sqlite3, sys
from multiprocessing import Pool
import numpy as np
from osgeo import gdal
from PIL import Image
gdal.UseExceptions()
src_p = sys.argv[1]; z, x0, y0, nx, ny = map(int, sys.argv[2:7])
out, q, procs = sys.argv[7], int(sys.argv[8]), int(sys.argv[9])
GAMMA = float(os.environ.get("RELIEF_GAMMA", "1"))
LUT = np.clip(np.round(255 * (np.arange(256) / 255) ** (1 / GAMMA)), 0, 255).astype(np.uint8)
_ds = None
def row(j):
    global _ds
    if _ds is None:
        _ds = gdal.Open(src_p)
    a = _ds.GetRasterBand(1).ReadAsArray(0, j * 256, nx * 256, 256)
    res = []
    for i in range(nx):
        t = LUT[a[:, i * 256:(i + 1) * 256]]
        buf = io.BytesIO()
        Image.fromarray(t, "L").convert("RGB").save(buf, "WEBP", quality=q, method=6)
        res.append((x0 + i, y0 + j, buf.getvalue(), bool((t == t.flat[0]).all())))
    return res
db = sqlite3.connect(out)
db.executescript("""
CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS images (tile_id TEXT PRIMARY KEY, tile_data BLOB);
CREATE TABLE IF NOT EXISTS map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT,
  PRIMARY KEY (zoom_level, tile_column, tile_row));
CREATE VIEW IF NOT EXISTS tiles AS SELECT map.zoom_level, map.tile_column, map.tile_row, images.tile_data
  FROM map JOIN images ON images.tile_id = map.tile_id;""")
db.execute("DELETE FROM map WHERE zoom_level=?", (z,))
n = uniform = 0
with Pool(procs) as pool:
    for res in pool.imap_unordered(row, range(ny), chunksize=1):
        for x, y, data, uni in res:
            h = hashlib.sha1(data).hexdigest()
            db.execute("INSERT OR IGNORE INTO images VALUES (?,?)", (h, data))
            db.execute("INSERT OR REPLACE INTO map VALUES (?,?,?,?)", (z, x, (2 ** z - 1) - y, h))
            n += 1; uniform += uni
        db.commit()
db.execute("DELETE FROM images WHERE tile_id NOT IN (SELECT tile_id FROM map)")
db.commit(); db.close()
print(f"z{z}: {n} tiles, {uniform} uniform")
