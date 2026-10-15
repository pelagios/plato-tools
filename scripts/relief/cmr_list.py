"""List SRTMGL3 v003 granule download URLs from NASA CMR.
usage: cmr_list.py W,S,E,N out.txt
Keeps only tiles whose SW corner lies in [W,E) x [S,N) (CMR bbox search also
returns neighbours that merely touch the box)."""
import json, re, sys, urllib.request
bbox, out = sys.argv[1], sys.argv[2]
W, S, E, N = (float(v) for v in bbox.split(","))
base = ("https://cmr.earthdata.nasa.gov/search/granules.json?short_name=SRTMGL3"
        f"&version=003&bounding_box={bbox}&page_size=2000")
urls, after = {}, None
while True:
    req = urllib.request.Request(base, headers={"User-Agent": "plato-tools-relief-build/0.1"})
    if after:
        req.add_header("CMR-Search-After", after)
    with urllib.request.urlopen(req, timeout=120) as r:
        after = r.headers.get("CMR-Search-After")
        entries = json.load(r)["feed"]["entry"]
    if not entries:
        break
    for e in entries:
        m = re.fullmatch(r"([NS])(\d\d)([EW])(\d{3})\.SRTMGL3\.hgt", e["title"])
        if not m:
            continue
        lat = int(m[2]) * (1 if m[1] == "N" else -1)
        lon = int(m[4]) * (1 if m[3] == "E" else -1)
        if not (W <= lon < E and S <= lat < N):
            continue
        for l in e["links"]:
            h = l.get("href", "")
            if h.startswith("https://") and h.endswith(".SRTMGL3.hgt.zip"):
                urls[e["title"]] = h
    if not after or len(entries) < 2000:
        break
with open(out, "w") as f:
    f.write("\n".join(urls[k] for k in sorted(urls)) + "\n")
print(f"{len(urls)} granules")
