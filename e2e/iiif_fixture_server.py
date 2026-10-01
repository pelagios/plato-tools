"""The IIIF fixture server for Chora's browser checks (e2e/app_test.py): two origins (two ports on
127.0.0.1), each logging every request it receives as one JSON line. That log is the census: the only
account of what reached a server (Playwright's request events also list requests the browser stopped).
First written for the Allmaps spike (2026-09-30), whose findings DEVELOPERS.md keeps.

    python3 e2e/iiif_fixture_server.py PORT_A PORT_B LOGFILE [PORT_C]

Serves test/fixtures/chora-iiif/, rewriting https://iiif.example.org to origin A and
https://elsewhere.example.org to origin B in the JSON it sends. Every response carries
Access-Control-Allow-Origin: *. The image information and the manifest name the site they were asked
for by (the Host header), so http://localhost:PORT_A is a third site, served by A's port: a map there is
admitted as its own.

  /iiif/grid/info.json          info-v2.json (its id on this origin)
  /iiif3/grid/info.json         info-v3.json
  /iiif/foreign/info.json       info-foreign-id.json: id on origin B
  /iiif/redirect/info.json      info-v2.json with id .../iiif/redirect on this origin
  /iiif/redirect/<rest>         302 to origin B /iiif/grid/<rest>
  /ark/<rest>                   302 to origin B /manifests/grid/manifest (an ARK resolver: another host)
  /iiif*/<name>/<...>/default.* grid.jpg
  /manifests/grid/manifest      manifest-rumsey-shaped.json
  /iiif/ink/info.json           info-ink.json (and /iiif/inkpng, /iiif/ink403, /iiif/inkbig), its id on the site asked
  /iiif/ink/<region>/<size>/<rotation>/<quality>.<format>
                                ink.png cut and scaled as IIIF says (Pillow, averaging): JPEG at /iiif/ink,
                                PNG at /iiif/inkpng (whatever the format asked); at /iiif/ink403 a tile at
                                full resolution is refused, 403, and any other given; /iiif/inkbig is
                                a 4097 x 3073 map drawn here (big()), 512-px tiles at 1, 2, 4 and 8

PORT_C, when given, is a third site that serves the same, but with no Access-Control-Allow-Origin: a
server that does not let other sites read what it sends (CORS).
"""
import io, json, re, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'test' / 'fixtures' / 'chora-iiif'
A, B, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
C = int(sys.argv[4]) if len(sys.argv) > 4 else None
lock = threading.Lock()
INK = None


def ink():
    global INK
    if INK is None:
        from PIL import Image
        INK = Image.open(ROOT / 'ink.png').convert('RGB')
    return INK


BIG = None
BIG_SIZE = (4097, 3073)
def big():
    """A large map for the tracing's budget (e2e/ink_budget.py), drawn here, the same each time: a river
    winding across it, 5 px wide (BIG_RIVER), a wash 900 px across (BIG_WASH), and linework, lettering and
    specks about them."""
    global BIG
    if BIG is None:
        import math, random
        from PIL import Image, ImageDraw
        r = random.Random(7)
        img = Image.new('RGB', BIG_SIZE, (238, 230, 210)); d = ImageDraw.Draw(img)
        d.polygon(BIG_WASH, fill=(176, 198, 150))
        for _ in range(140):
            x, y = r.uniform(0, BIG_SIZE[0]), r.uniform(0, BIG_SIZE[1])
            d.line([(x, y), (x + r.uniform(-400, 400), y + r.uniform(-400, 400))], fill=(60, 52, 46), width=r.choice([2, 3]))
        for _ in range(400):
            x, y = r.uniform(0, BIG_SIZE[0]), r.uniform(0, BIG_SIZE[1])
            d.text((x, y), r.choice(['Mill', 'Ford', 'Wood', 'Ch.', 'Farm']), fill=(40, 34, 30))
        d.line(BIG_RIVER, fill=(30, 26, 24), width=5, joint='curve')
        for _ in range(20000):
            x, y = r.randrange(BIG_SIZE[0]), r.randrange(BIG_SIZE[1]); img.putpixel((x, y), (120, 110, 100))
        BIG = img
    return BIG
import math as _m
BIG_RIVER = [(300 + 3.4 * k, 1500 + 700 * _m.sin(k / 160)) for k in range(1001)]
BIG_WASH = [(2500, 300), (3350, 420), (3420, 1100), (3000, 1250), (2550, 1000)]


def iiif_image(region, size, img=None):
    """The image request's pixels, as IIIF says: region 'full' or x,y,w,h; size max, w,h, w, ,h or !w,h."""
    from PIL import Image
    img = img or ink()
    W, H = img.size
    if region in ('full', 'max'):
        x, y, w, h = 0, 0, W, H
    else:
        x, y, w, h = (int(v) for v in region.split(','))
        w, h = min(w, W - x), min(h, H - y)
    if size in ('max', 'full'):
        sw, sh = w, h
    elif size.startswith('!'):
        bw, bh = (int(v) for v in size[1:].split(','))
        k = min(bw / w, bh / h); sw, sh = round(w * k), round(h * k)
    else:
        a, b = size.split(',')
        sw = int(a) if a else round(w * int(b) / h)
        sh = int(b) if b else round(h * int(a) / w)
    return img.crop((x, y, x + w, y + h)).resize((sw, sh), Image.BOX), (w, h, sw, sh)


def origin(port):
    return f'http://127.0.0.1:{port}'


def fixture(name):
    text = (ROOT / name).read_text()
    return text.replace('https://iiif.example.org', origin(A)).replace('https://elsewhere.example.org', origin(B))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def census(self, status):
        rec = {'t': round(time.time(), 3), 'port': self.server.server_port, 'method': self.command,
               'path': self.path, 'status': status}
        for h in ('Origin', 'Referer', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site'):
            if self.headers.get(h):
                rec[h.lower()] = self.headers.get(h)
        with lock, open(LOG, 'a') as f:
            f.write(json.dumps(rec) + '\n')

    def send(self, status, body=b'', ctype='application/json', extra=()):
        self.census(status)
        self.send_response(status)
        if self.server.server_port != C:
            self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        for k, v in extra:
            self.send_header(k, v)
        if status != 302:
            self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send(204, extra=[('Access-Control-Allow-Headers', '*'), ('Access-Control-Allow-Methods', 'GET')])

    def do_GET(self):
        path = self.path.split('?')[0]
        here = self.server.server_port
        me = 'http://' + (self.headers.get('Host') or f'127.0.0.1:{here}')   # the site it was asked for by
        if path == '/iiif/grid/info.json':
            return self.send(200, fixture('info-v2.json').replace(origin(A), me).encode())
        if path == '/iiif3/grid/info.json':
            return self.send(200, fixture('info-v3.json').replace(origin(A), me).encode())
        if path == '/iiif/foreign/info.json':
            return self.send(200, fixture('info-foreign-id.json').encode())
        if path == '/iiif/redirect/info.json':
            body = fixture('info-v2.json').replace('/iiif/grid', '/iiif/redirect').replace(origin(A), me)
            return self.send(200, body.encode())
        if path.startswith('/ark/'):
            return self.send(302, extra=[('Location', origin(B) + '/manifests/grid/manifest')])
        if path.startswith('/iiif/redirect/'):
            return self.send(302, extra=[('Location', origin(B) + '/iiif/grid/' + self.path[len('/iiif/redirect/'):])])
        if path == '/manifests/grid/manifest':
            return self.send(200, fixture('manifest-rumsey-shaped.json').replace(origin(A), me).encode())
        m = re.match(r'^/iiif/(ink|inkpng|ink403|inkbig)/(.+)$', path)
        if m:
            name, rest = m.groups()
            if rest == 'info.json':
                info = fixture('info-ink.json').replace(origin(A) + '/iiif/ink', me + '/iiif/' + name)
                if name == 'inkbig':
                    j = json.loads(info); j.update(width=BIG_SIZE[0], height=BIG_SIZE[1], sizes=[], tiles=[{'width': 512, 'height': 512, 'scaleFactors': [1, 2, 4, 8]}]); info = json.dumps(j)
                return self.send(200, info.encode())
            parts = rest.split('/')
            if len(parts) != 4:
                return self.send(404, b'{"error":"not an image request"}')
            out, (w, h, sw, sh) = iiif_image(parts[0], parts[1], big() if name == 'inkbig' else None)
            if name == 'ink403' and (sw, sh) == (w, h):
                return self.send(403, b'{"error":"forbidden"}')
            buf = io.BytesIO()
            if name == 'inkpng':
                out.save(buf, 'PNG'); ctype = 'image/png'
            else:
                out.save(buf, 'JPEG', quality=92); ctype = 'image/jpeg'
            return self.send(200, buf.getvalue(), ctype)
        if path.startswith('/iiif') and path.rsplit('/', 1)[-1].startswith('default.'):
            return self.send(200, (ROOT / 'grid.jpg').read_bytes(), 'image/jpeg')
        return self.send(404, b'{"error":"not a fixture"}')

    do_HEAD = do_GET


servers = [ThreadingHTTPServer(('127.0.0.1', p), Handler) for p in (A, B, C) if p]
for s in servers:
    threading.Thread(target=s.serve_forever, daemon=True).start()
print(f'fixture origins {origin(A)} {origin(B)}' + (f' {origin(C)} (no CORS)' if C else ''), flush=True)
threading.Event().wait()
