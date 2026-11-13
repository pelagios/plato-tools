#!/usr/bin/env python3
"""Build public/try/plato-tools-try-files.zip from examples/try-files/, the same
bytes every time: files in sorted order, a fixed timestamp, fixed permissions.

    python3 scripts/build-try-zip.py [--check]

--check builds in memory and fails if the zip in public/try/ differs."""
import io, os, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'examples', 'try-files')
OUT = os.path.join(HERE, '..', 'public', 'try', 'plato-tools-try-files.zip')
STAMP = (2026, 11, 13, 0, 0, 0)

def build():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(SRC):
            dirs.sort()
            for f in sorted(files):
                path = os.path.join(root, f)
                name = 'try-files/' + os.path.relpath(path, SRC).replace(os.sep, '/')
                info = zipfile.ZipInfo(name, STAMP)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                info.create_system = 3
                with open(path, 'rb') as fh:
                    z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED, 9)
    return buf.getvalue()

if __name__ == '__main__':
    data = build()
    if '--check' in sys.argv:
        same = os.path.exists(OUT) and open(OUT, 'rb').read() == data
        print('up to date' if same else 'DIFFERS: run scripts/build-try-zip.py')
        sys.exit(0 if same else 1)
    with open(OUT, 'wb') as fh:
        fh.write(data)
    print(f'{OUT}: {len(data)} bytes')
