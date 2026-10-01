"""The IIIF fixture server for Chora's browser checks (e2e/app_test.py): two origins (two ports on
127.0.0.1), each logging every request it receives as one JSON line. That log is the census: the only
account of what reached a server (Playwright's request events also list requests the browser stopped).
First written for the Allmaps spike (2026-09-30), whose findings DEVELOPERS.md keeps.

    python3 e2e/iiif_fixture_server.py PORT_A PORT_B LOGFILE

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
"""
import json, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'test' / 'fixtures' / 'chora-iiif'
A, B, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
lock = threading.Lock()


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
        if path.startswith('/iiif') and path.rsplit('/', 1)[-1].startswith('default.'):
            return self.send(200, (ROOT / 'grid.jpg').read_bytes(), 'image/jpeg')
        return self.send(404, b'{"error":"not a fixture"}')

    do_HEAD = do_GET


servers = [ThreadingHTTPServer(('127.0.0.1', p), Handler) for p in (A, B)]
for s in servers:
    threading.Thread(target=s.serve_forever, daemon=True).start()
print(f'fixture origins {origin(A)} {origin(B)}', flush=True)
threading.Event().wait()
