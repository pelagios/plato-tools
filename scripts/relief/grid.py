"""Tile-aligned EPSG:3857 grid for a lon/lat box at one zoom.
usage: grid.py zoom W S E N  ->  prints: xmin ymin xmax ymax width height res x0 y0 nx ny
(x0,y0 = XYZ index of the top-left tile; nx,ny = tile counts)."""
import math, sys
z = int(sys.argv[1]); W, S, E, N = map(float, sys.argv[2:6])
R = 6378137.0; ORIG = math.pi * R; n = 2 ** z; span = 2 * ORIG / n
def tx(lon): return (lon + 180) / 360 * n
def ty(lat): return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
x0, x1 = math.floor(tx(W)), math.ceil(tx(E) - 1e-9)
y0, y1 = math.floor(ty(N)), math.ceil(ty(S) - 1e-9)
x1, y1 = min(x1, n), min(y1, n)
nx, ny = x1 - x0, y1 - y0
xmin = -ORIG + x0 * span; xmax = -ORIG + x1 * span
ymax = ORIG - y0 * span; ymin = ORIG - y1 * span
print(f"{xmin:.6f} {ymin:.6f} {xmax:.6f} {ymax:.6f} {nx*256} {ny*256} {span/256:.10f} {x0} {y0} {nx} {ny}")
