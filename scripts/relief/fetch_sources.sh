#!/usr/bin/env bash
# Fetch the source DEMs for the PLATO shaded-relief tileset.
#   fetch_sources.sh <data_dir> [W S E N]
# Resumable: files already present (and valid) are skipped. Records size and
# sha256 of every file in <data_dir>/MANIFEST.tsv.
# SRTMGL3 needs EARTHDATA_TOKEN in the environment (sent as a bearer header on
# stdin to curl, so it never appears in argv, a URL, a log or a file).
set -euo pipefail
DATA=$(realpath "$1"); W=${2:--16}; S=${3:-14}; E=${4:-61}; N=${5:-60}
SCRIPTS=$(dirname "$(realpath "$0")")
mkdir -p "$DATA/srtm" "$DATA/gmted" "$DATA/lists"
: "${EARTHDATA_TOKEN:?EARTHDATA_TOKEN not set}"

# 1. SRTMGL3 granule list from CMR (paged with CMR-Search-After).
LIST="$DATA/lists/srtm_urls.txt"
if [ ! -s "$LIST" ]; then
  /usr/bin/python3 -I "$SCRIPTS/cmr_list.py" "$W,$S,$E,$N" "$LIST"
fi
echo "SRTM granules listed: $(wc -l < "$LIST")"

fetch_one() {  # url dest
  local url=$1 dest=$2
  if [ -s "$dest" ] && unzip -tqq "$dest" >/dev/null 2>&1; then return 0; fi
  local i
  for i in 1 2 3 4; do
    if printf 'Authorization: Bearer %s\n' "$EARTHDATA_TOKEN" \
       | curl -sS -f -L --retry 2 --connect-timeout 30 --max-time 600 -H @- \
              -A "plato-tools-relief-build/0.1" -o "$dest.part" "$url" 2>/dev/null \
       && unzip -tqq "$dest.part" >/dev/null 2>&1; then
      mv "$dest.part" "$dest"; return 0
    fi
    sleep $((i * 5))
  done
  rm -f "$dest.part"; echo "FAILED $(basename "$dest")" >&2; return 1
}
export -f fetch_one
export EARTHDATA_TOKEN
# 4 at a time.
awk -v d="$DATA/srtm" '{ n=split($0,a,"/"); print $0 "\t" d "/" a[n] }' "$LIST" \
  | xargs -P 4 -d '\n' -n 1 bash -c 'IFS=$'"'"'\t'"'"' read -r u f <<< "$1"; fetch_one "$u" "$f"' _ \
  || echo "some SRTM downloads failed; re-run to resume" >&2

# 2. GMTED2010 7.5" mean tiles for 50-70N (only 60-62N is used). No login.
G=https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/topo/downloads/GMTED/Global_tiles_GMTED/075darcsec/mea
for t in W030/50N030W E000/50N000E E030/50N030E; do
  f="$DATA/gmted/$(basename "$t")_20101117_gmted_mea075.tif"
  if [ ! -s "$f" ] || ! gdalinfo "$f" >/dev/null 2>&1; then
    curl -sS -f -L --retry 3 -A "plato-tools-relief-build/0.1" -C - -o "$f" "$G/${t}_20101117_gmted_mea075.tif"
  fi
done

# 2b. GMTED2010 30" mean, global (277 MB), as the background for low zooms,
#     whose tile envelopes reach beyond the SRTM download.
f="$DATA/gmted/mn30_grd.zip"
if [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" != 277229566 ]; then
  curl -sS -f -L --retry 3 -A "plato-tools-relief-build/0.1" -C - -o "$f" \
    https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/topo/downloads/GMTED/Grid_ZipFiles/mn30_grd.zip
fi

# 3. Manifest.
( cd "$DATA"
  printf 'file\tbytes\tsha256\n'
  find srtm gmted -type f ! -name '*.part' | sort | while read -r f; do
    printf '%s\t%s\t%s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
  done ) > "$DATA/MANIFEST.tsv"
echo "files: $(($(wc -l < "$DATA/MANIFEST.tsv") - 1)), bytes: $(awk -F'\t' 'NR>1{s+=$2}END{print s}' "$DATA/MANIFEST.tsv")"
