#!/usr/bin/env bash
# Build relief.pmtiles: public-domain multidirectional shaded relief, grey WebP.
#   build.sh <data_dir> <work_dir> <out.pmtiles>
# data_dir is what fetch_sources.sh filled (srtm/*.zip, gmted/*.tif).
# Every heavy step goes through ~/.config/plato-tools/heavy.sh (one at a time)
# and is timed with /usr/bin/time -v into <work_dir>/logs/<step>.time.
# Env: PMTILES (path to the pmtiles CLI), PROCS (default 8), QUALITY (80),
#      FROM_STEP (skip steps that already produced their output: they are
#      skipped anyway when the output file exists), ZF_BASE (exaggeration).
set -euo pipefail
DATA=$(realpath "$1"); WORK=$(realpath -m "$2"); OUT=$(realpath -m "$3")
SCRIPTS=$(dirname "$(realpath "$0")")
PMTILES=${PMTILES:-pmtiles}; PROCS=${PROCS:-8}; QUALITY=${QUALITY:-80}
HEAVY=${HEAVY:-$HOME/.config/plato-tools/heavy.sh}
PY="/usr/bin/python3 -I"
WIDE="-15 15 60 62"; MED="-10 28 45 47"; WIDE_MAX=10; MED_ZOOM=11
mkdir -p "$WORK/logs" "$WORK/hgt" "$WORK/dem" "$WORK/hs"
export GDAL_CACHEMAX=1024
GT=(-co TILED=YES -co COMPRESS=ZSTD -co BIGTIFF=YES -co NUM_THREADS=4)
WARP=(-multi -wo NUM_THREADS=8 -wm 1024 -overwrite)

heavy() {  # name cmd...
  local name=$1; shift
  echo "[$(date +%T)] $name" >&2
  "$HEAVY" /usr/bin/time -v -o "$WORK/logs/$name.time" "$@" > "$WORK/logs/$name.log" 2>&1 \
    || { echo "step $name failed; see $WORK/logs/$name.log" >&2; tail -5 "$WORK/logs/$name.log" >&2; exit 1; }
  awk -F': ' '/Maximum resident/ {printf "  peak RSS %.0f MB", $2/1024} /Elapsed/ {print ", wall " $2}' "$WORK/logs/$name.time" >&2
}
grid() { $PY "$SCRIPTS/grid.py" "$@"; }
# Vertical exaggeration per zoom: 1 at z11, x ZF_BASE per zoom out.
zf() { awk -v z="$1" -v b="${ZF_BASE:-1.4}" 'BEGIN { printf "%.4f", b ^ (11 - z) }'; }

# 1. Unpack the hgt tiles (only the one expected member of each zip).
if [ ! -s "$WORK/srtm.vrt" ]; then
  for z in "$DATA"/srtm/*.SRTMGL3.hgt.zip; do
    t=$(basename "$z" .SRTMGL3.hgt.zip)
    [ -s "$WORK/hgt/$t.hgt" ] && continue
    # The member is <tile>.hgt, or <tile>.SRTMGL3.hgt in some (Caspian) granules.
    m=$(unzip -Z1 "$z" | grep -xE "$t(\.SRTMGL3)?\.hgt" | head -1)
    [ -n "$m" ] || { echo "no hgt member in $z" >&2; exit 1; }
    unzip -p "$z" "$m" > "$WORK/hgt/$t.hgt.part" && mv "$WORK/hgt/$t.hgt.part" "$WORK/hgt/$t.hgt"
  done
  ls "$WORK"/hgt/*.hgt > "$WORK/hgt.list"
  gdalbuildvrt -q -input_file_list "$WORK/hgt.list" -srcnodata -32768 -vrtnodata -32768 "$WORK/srtm.vrt"
fi
# 2. GMTED2010 band north of SRTM, resampled to SRTM's 3" grid, then one VRT
#    with SRTM on top (later sources win in a VRT).
if [ ! -s "$WORK/dem4326.vrt" ]; then
  gdalbuildvrt -q "$WORK/gmted.vrt" "$DATA"/gmted/*_gmted_mea075.tif
  heavy gmted_band gdalwarp "${WARP[@]}" -te -16 59.5 61 63.5 -tr 0.000833333333333 0.000833333333333 \
    -r cubic -ot Int16 -srcnodata -32768 -dstnodata -32768 "${GT[@]}" "$WORK/gmted.vrt" "$WORK/dem/gmted_band.tif"
  # Same colour interpretation as the hgt tiles, or gdalbuildvrt skips sources.
  gdal_translate -q -of VRT -colorinterp undefined "$WORK/dem/gmted_band.tif" "$WORK/gmted_band.vrt"
  { echo "$WORK/gmted_band.vrt"; cat "$WORK/hgt.list"; } > "$WORK/dem4326.list"
  gdalbuildvrt -q -resolution highest -srcnodata -32768 -vrtnodata -32768 \
    -input_file_list "$WORK/dem4326.list" "$WORK/dem4326.vrt"
  [ "$(grep -c '<SourceFilename' "$WORK/dem4326.vrt")" -eq "$(wc -l < "$WORK/dem4326.list")" ] \
    || { echo "dem4326.vrt is missing sources" >&2; exit 1; }
fi

# 3. Per-zoom DEMs in EPSG:3857, each at its zoom's resolution on the tile grid.
#    Sea / no data becomes 0 m (flat), so it shades to one uniform grey.
demwarp() {  # zoom box resampling out src... (later sources on top)
  local z=$1 box=$2 r=$3 out=$4; shift 4
  read -r xmin ymin xmax ymax w h _ <<< "$(grid "$z" $box)"
  heavy "dem_z$z" gdalwarp "${WARP[@]}" -t_srs EPSG:3857 -te "$xmin" "$ymin" "$xmax" "$ymax" -ts "$w" "$h" \
    -r "$r" -ot Int16 -dstnodata None -wo INIT_DEST=0 "${GT[@]}" -co PREDICTOR=2 "$@" "$out"
}
# Zooms below WIDE_MAX have tile envelopes larger than the one above them (and
# beyond the SRTM download at z<8): GMTED2010 30" goes underneath, so no cliff.
BG_MAX=$((WIDE_MAX - 1))
BG="/vsizip/$DATA/gmted/mn30_grd.zip/mn30_grd"
[ -s "$WORK/dem/z$MED_ZOOM.tif" ] || demwarp $MED_ZOOM "$MED" cubic "$WORK/dem/z$MED_ZOOM.tif" "$WORK/dem4326.vrt"
[ -s "$WORK/dem/z$WIDE_MAX.tif" ] || demwarp $WIDE_MAX "$WIDE" average "$WORK/dem/z$WIDE_MAX.tif" "$WORK/dem4326.vrt"
for ((z = WIDE_MAX - 1; z >= 0; z--)); do
  bg=(); [ "$z" -le "$BG_MAX" ] && bg=("$BG")
  [ -s "$WORK/dem/z$z.tif" ] || demwarp $z "$WIDE" average "$WORK/dem/z$z.tif" "${bg[@]}" "$WORK/dem/z$((z + 1)).tif"
done

# 4. Hillshade each zoom (true-metre slopes at every latitude, see scale_dem.py)
#    and cut it into WebP tiles in one MBTiles file.
MB="$WORK/relief.mbtiles"
for ((z = 0; z <= MED_ZOOM; z++)); do
  box=$WIDE; [ "$z" -eq "$MED_ZOOM" ] && box=$MED
  [ -s "$WORK/hs/z$z.done" ] && continue
  read -r _ _ _ _ _ _ _ x0 y0 nx ny <<< "$(grid "$z" $box)"
  heavy "scale_z$z" $PY "$SCRIPTS/scale_dem.py" "$WORK/dem/z$z.tif" "$WORK/dem/z${z}_scaled.tif" "$(zf "$z")"
  heavy "hillshade_z$z" gdaldem hillshade -multidirectional -s 1 -compute_edges "${GT[@]}" \
    "$WORK/dem/z${z}_scaled.tif" "$WORK/hs/z$z.tif"
  rm -f "$WORK/dem/z${z}_scaled.tif"
  heavy "tile_z$z" $PY "$SCRIPTS/tile.py" "$WORK/hs/z$z.tif" "$z" "$x0" "$y0" "$nx" "$ny" "$MB" "$QUALITY" "$PROCS"
  tail -1 "$WORK/logs/tile_z$z.log" > "$WORK/hs/z$z.done"; cat "$WORK/hs/z$z.done" >&2
done

# 5. Metadata, then one PMTiles file.
ATTR='Shaded relief from NASA SRTM (public domain); USGS GMTED2010 (public domain)'
DESC="Multidirectional shaded relief (gdaldem), grey WebP 256 px q$QUALITY. z0-$WIDE_MAX: 15°W-60°E, 15°N-62°N; z$MED_ZOOM: Mediterranean 10°W-45°E, 28°N-47°N. Sources: NASA SRTMGL3 v3 (3 arc-second, void-filled), USGS GMTED2010 7.5 arc-second mean north of 60°N and 30 arc-second mean outside the SRTM area at low zooms. Vertical exaggeration $(printf %.0f "$(zf 0)")x at z0 to 1x at z$MED_ZOOM. Built for PLATO tools."
$PY "$SCRIPTS/metadata.py" "$MB" "name=PLATO shaded relief" format=webp type=baselayer version=1 \
  minzoom=0 "maxzoom=$MED_ZOOM" "bounds=-15,15,60,62" "center=25,40,4" "attribution=$ATTR" "description=$DESC"
mkdir -p "$(dirname "$OUT")"; rm -f "$OUT"
heavy pmtiles_convert "$PMTILES" convert "$MB" "$OUT"
ls -l "$OUT" >&2
