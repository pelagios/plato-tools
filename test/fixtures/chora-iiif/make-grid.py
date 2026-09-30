"""Draw grid.jpg, the synthetic map image of these fixtures: 512 x 512 pixels, a line every
64 pixels (every 128 heavier), each 128-pixel cell labelled with its column and row, and a red
ring at each of the four control points of annotation.json.

    python3 test/fixtures/chora-iiif/make-grid.py     (Pillow; written with 10.4.0)
"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
SIZE, STEP = 512, 64
GCPS = [(64, 64), (448, 64), (448, 448), (64, 448)]

img = Image.new('RGB', (SIZE, SIZE), (246, 238, 214))
d = ImageDraw.Draw(img)
for v in range(0, SIZE + 1, STEP):
    heavy = v % 128 == 0
    colour, width = ((60, 60, 60), 3) if heavy else ((150, 150, 150), 1)
    d.line([(v, 0), (v, SIZE)], fill=colour, width=width)
    d.line([(0, v), (SIZE, v)], fill=colour, width=width)
for cx in range(0, SIZE, 128):
    for cy in range(0, SIZE, 128):
        d.text((cx + 8, cy + 8), f'{cx // 128},{cy // 128}', fill=(20, 20, 120))
for x, y in GCPS:
    d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=(200, 0, 0), width=3)
img.save(HERE / 'grid.jpg', quality=85, optimize=False, progressive=False)
print(HERE / 'grid.jpg')
