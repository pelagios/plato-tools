"""Draw ink.png, the synthetic map that Chora's assisted tracing is checked on in the browser
(e2e/app_test.py): 1001 x 701 pixels (odd on purpose: the tiles at the edges are not at their scale
factor), on paper, with

  - a river: a dark line, 4 px wide, along RIVER (image pixels; the centreline);
  - a wash: an area of brick red, WASH, with no outline, and a hole in it (ISLAND, paper: a field
    left white), too large to be taken for lettering;
  - a road: a dark line, 3 px wide, straight along ROAD, for snapping to;
  - lettering, and a few marks, that a trace must not take for the river.

    python3 test/fixtures/chora-iiif/make-ink.py     (Pillow; written with 10.4.0)

The coordinates are printed for app_test.py, which keeps the same numbers (INK_* there).
"""
from pathlib import Path
from PIL import Image, ImageDraw
import math

HERE = Path(__file__).parent
W, H = 1001, 701
PAPER, INK, BRICK = (240, 232, 212), (38, 32, 28), (190, 86, 64)
RIVER = [(90 + 8 * k, 560 - 300 * math.sin(math.pi * k / 100) * (0.4 + 0.6 * k / 100)) for k in range(101)]
WASH = [(420, 90), (610, 120), (650, 260), (560, 330), (430, 300), (380, 180)]
ROAD = [(120, 640), (900, 610)]
ISLAND = (440, 130, 500, 180)   # PIL's rectangle, inclusive: pixels 440..500 by 130..180

img = Image.new('RGB', (W, H), PAPER)
d = ImageDraw.Draw(img)
d.polygon(WASH, fill=BRICK)
d.rectangle(ISLAND, fill=PAPER)
d.line(RIVER, fill=INK, width=4, joint='curve')
d.line(ROAD, fill=INK, width=3)
for k, ch in enumerate('RIVER'):
    d.text((700 + 14 * k, 300), ch, fill=INK)
for x, y in [(200, 200), (820, 450), (300, 420)]:
    d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=INK)
img.save(HERE / 'ink.png', optimize=True)
print('RIVER', [(round(x, 3), round(y, 3)) for x, y in RIVER[::10]])
print('WASH', WASH, 'ISLAND', ISLAND, 'ROAD', ROAD)
