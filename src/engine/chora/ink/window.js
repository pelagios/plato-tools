// The window: the part of a IIIF image read for tracing, as one grid of working pixels at one scale
// factor s, composed from the image's tiles.
//
// - Tiles are asked for exactly as Allmaps' renderer asks for them (@allmaps/iiif-parser's
//   getTileImageRequest and getImageUrl, formats webp then jpg), so that the browser's cache serves both:
//   the image's own `tiles` when its information gives them (a level-0 server offers nothing else), and
//   otherwise the parser's regions of a default tiling (a level-1 or level-2 server, which takes any
//   region and size). An image offering neither cannot be traced (nor drawn).
// - A tile at the edge of the image is not at scale s: its region is cut by the image's edge and its size
//   rounded. So each tile is placed by its region, and scaled across and down by its region's size over
//   its bitmap's actual size (compose), never by s.
// - Working pixel (i, j) covers image pixels [x0 + i·s, x0 + (i+1)·s) × [y0 + j·s, y0 + (j+1)·s).
export const WINDOW = 512;          // working pixels each way, at first
export const MAX_WINDOW = 2048;     // the most it grows to
export const FORMATS = ['webp', 'jpg'];

/** The scale factors the image offers (its tiles', or its default tiling's), smallest first. */
export const scaleFactors = (image) => [...new Set(image.tileZoomLevels.map((z) => z.scaleFactor))].sort((a, b) => a - b);

/**
 * The scale factor to read at: the smallest offered that is at least half the image pixels per screen
 * pixel at the view (finer than that is more than the eye was shown; coarser loses what it saw). The
 * coarsest offered when none is so coarse.
 */
export function chooseScale(image, imagePxPerScreenPx) {
  const sfs = scaleFactors(image);
  return sfs.find((s) => s >= imagePxPerScreenPx / 2) ?? sfs.at(-1);
}

/**
 * The window of `size` working pixels each way (or [w, h]) at scale s around image pixel (cx, cy),
 * within the image: { x0, y0, s, w, h } (x0, y0 in image pixels, on the working grid).
 */
export function frameAround(image, [cx, cy], s, size = WINDOW) {
  const [sw, sh] = Array.isArray(size) ? size : [size, size];
  const W = Math.ceil(image.width / s), H = Math.ceil(image.height / s);
  const w = Math.min(sw, W), h = Math.min(sh, H);
  const i0 = Math.max(0, Math.min(W - w, Math.round(cx / s - w / 2))), j0 = Math.max(0, Math.min(H - h, Math.round(cy / s - h / 2)));
  return { x0: i0 * s, y0: j0 * s, s, w, h };
}

/** The window grown to twice its size each way about its centre (at most MAX_WINDOW), or null when it cannot grow. */
export function grow(image, frame, max = MAX_WINDOW) {
  const W = Math.ceil(image.width / frame.s), H = Math.ceil(image.height / frame.s);
  const w = Math.min(max, W, frame.w * 2), h = Math.min(max, H, frame.h * 2);
  if (w === frame.w && h === frame.h) return null;
  const cx = frame.x0 + (frame.w * frame.s) / 2, cy = frame.y0 + (frame.h * frame.s) / 2;
  return frameAround(image, [cx, cy], frame.s, [w, h]);
}

/**
 * The tile requests that cover the window: [{ url, region: {x, y, width, height}, size: {width, height} }],
 * built as the renderer builds them. Throws when the image offers no tiles at that scale factor, or a
 * request would be larger than the server allows.
 */
export function tilesFor(image, frame) {
  const zl = image.tileZoomLevels.filter((z) => z.scaleFactor === frame.s).sort((a, b) => b.width - a.width)[0];
  if (!zl) throw new Error(`The image offers no tiles at 1/${frame.s} of its size.`);
  const X0 = frame.x0, Y0 = frame.y0, X1 = Math.min(image.width, frame.x0 + frame.w * frame.s), Y1 = Math.min(image.height, frame.y0 + frame.h * frame.s);
  const c0 = Math.floor(X0 / zl.originalWidth), c1 = Math.min(zl.columns - 1, Math.floor((X1 - 1) / zl.originalWidth));
  const r0 = Math.floor(Y0 / zl.originalHeight), r1 = Math.min(zl.rows - 1, Math.floor((Y1 - 1) / zl.originalHeight));
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const req = image.getTileImageRequest(zl, c, r);
    const { width, height } = req.size;
    if ((image.maxWidth && width > image.maxWidth) || (image.maxHeight && height > image.maxHeight) || (image.maxArea && width * height > image.maxArea)) {
      throw new Error(`The image server does not give pieces of the map as large as its own tiles at 1/${frame.s} of its size.`);
    }
    out.push({ url: image.getImageUrl(req, { preferredFormats: FORMATS }), region: req.region, size: req.size });
  }
  return out;
}

/**
 * The window's pixels (RGBA, w × h) from tiles [{ region, width, height, data }] (data the bitmap's RGBA,
 * width × height its actual size). Each working pixel takes the tile whose region it lies in, read
 * at the tile's own scale across and down (region.width / width, region.height / height), bilinearly; a
 * tile whose bitmap is exactly its region at scale s is copied pixel for pixel. Pixels no tile covers
 * are left transparent (alpha 0). Returns { rgba, covered } (covered: the share of pixels set).
 */
export function compose(frame, tiles) {
  const { x0, y0, s, w, h } = frame;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let covered = 0;
  for (const t of tiles) {
    const { x: rx, y: ry, width: rw, height: rh } = t.region;
    const kx = t.width / rw, ky = t.height / rh;
    // The working pixels this region overlaps. Tiles meet on the working grid (their regions are
    // multiples of s), so only a pixel at the image's own edge, part off the image, is shared by none.
    const i0 = Math.max(0, Math.floor((rx - x0) / s)), i1 = Math.min(w - 1, Math.ceil((rx + rw - x0) / s) - 1);
    const j0 = Math.max(0, Math.floor((ry - y0) / s)), j1 = Math.min(h - 1, Math.ceil((ry + rh - y0) / s) - 1);
    for (let j = j0; j <= j1; j++) {
      const v = Math.min(t.height - 1, Math.max(0, (y0 + (j + 0.5) * s - ry) * ky - 0.5));
      const va = Math.floor(v), vb = Math.min(t.height - 1, va + 1), fy = v - va;
      for (let i = i0; i <= i1; i++) {
        const u = Math.min(t.width - 1, Math.max(0, (x0 + (i + 0.5) * s - rx) * kx - 0.5));
        const ua = Math.floor(u), ub = Math.min(t.width - 1, ua + 1), fx = u - ua;
        const o = (j * w + i) * 4;
        if (!rgba[o + 3]) covered++;
        const a = (va * t.width + ua) * 4, b = (va * t.width + ub) * 4, c = (vb * t.width + ua) * 4, d = (vb * t.width + ub) * 4;
        for (let k = 0; k < 4; k++) {
          rgba[o + k] = (t.data[a + k] * (1 - fx) + t.data[b + k] * fx) * (1 - fy) + (t.data[c + k] * (1 - fx) + t.data[d + k] * fx) * fy;
        }
        if (!rgba[o + 3]) rgba[o + 3] = 255;
      }
    }
  }
  return { rgba, covered: covered / (w * h) };
}
