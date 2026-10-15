"""Write MBTiles metadata. usage: metadata.py file.mbtiles key=value ..."""
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("DELETE FROM metadata")
db.executemany("INSERT INTO metadata VALUES (?,?)", [a.split("=", 1) for a in sys.argv[2:]])
db.commit(); db.close()
