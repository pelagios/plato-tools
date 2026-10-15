"""Prepare a 3857 DEM for gdaldem: multiply each row by zf / cos(lat), so that
gdaldem -s 1 sees slopes in true metres at every latitude (a Mercator pixel is
cos(lat) times shorter on the ground than its nominal size).
usage: scale_dem.py in.tif out.tif zfactor"""
import math, sys
import numpy as np
from osgeo import gdal
gdal.UseExceptions()
src_p, dst_p, zf = sys.argv[1], sys.argv[2], float(sys.argv[3])
src = gdal.Open(src_p); b = src.GetRasterBand(1)
W, H = src.RasterXSize, src.RasterYSize; gt = src.GetGeoTransform()
dst = gdal.GetDriverByName("GTiff").Create(dst_p, W, H, 1, gdal.GDT_Float32,
    ["TILED=YES", "COMPRESS=ZSTD", "PREDICTOR=3", "BIGTIFF=YES", "NUM_THREADS=4"])
dst.SetGeoTransform(gt); dst.SetProjection(src.GetProjection())
db = dst.GetRasterBand(1)
R = 6378137.0
step = 512
for r0 in range(0, H, step):
    h = min(step, H - r0)
    a = b.ReadAsArray(0, r0, W, h).astype(np.float32)
    y = gt[3] + (np.arange(r0, r0 + h) + 0.5) * gt[5]
    lat = np.degrees(2 * np.arctan(np.exp(y / R)) - math.pi / 2)
    a *= (zf / np.cos(np.radians(lat)))[:, None].astype(np.float32)
    db.WriteArray(a, 0, r0)
db.FlushCache(); dst = None
