"""What this build has to be able to do, run inside the interpreter it built.

Every line here is something the published wasm32-wasi artifacts cannot do:
_sysconfigdata__wasi_wasm32-wasi.py in brettcannon/cpython-wasi-build reports
ZLIB MISSING, and _SSL, _HASHLIB, _CTYPES, _LZMA and _BZ2 alongside it, so
zipfile cannot inflate and no wheel can be unpacked.

Run by build-python.sh's verify stage under wasmtime, with a single preopen at
'/' — the shape Nimbus gives a guest.
"""

import asyncio, decimal, hashlib, io, json, mmap, os, select, socket, sqlite3, ssl, sys
import bz2, lzma, zipfile, zlib

failures = []


def check(label, got, want=None):
    ok = got == want if want is not None else bool(got)
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got}")
    if not ok:
        failures.append(label)


print(f"{sys.version.split()[0]} on {sys.platform}")
check("openssl", ssl.OPENSSL_VERSION.startswith("OpenSSL"))
check("sqlite", sqlite3.sqlite_version.split(".")[0], "3")

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("a", b"y" * 10000)
with zipfile.ZipFile(buf) as z:
    check("zipfile deflate roundtrip", len(z.read("a")), 10000)
check("zlib", len(zlib.decompress(zlib.compress(b"z" * 5000))), 5000)
check("lzma", len(lzma.decompress(lzma.compress(b"z" * 5000))), 5000)
check("bz2", len(bz2.decompress(bz2.compress(b"z" * 5000))), 5000)

con = sqlite3.connect(":memory:")
con.execute("create table t(a)")
con.execute("insert into t values('live')")
check("sqlite roundtrip", con.execute("select a from t").fetchone()[0], "live")

check("hashlib openssl-backed", "ripemd160" in hashlib.algorithms_available)
check("pbkdf2", len(hashlib.pbkdf2_hmac("sha256", b"p", b"s", 10)), 32)
check("ssl context", ssl.create_default_context().minimum_version.value > 0)

check("os.getuid", os.getuid() >= 0)
check("os.umask", os.umask(0o022) >= 0)
check("os.lstat", os.lstat(__file__).st_size > 0)

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
check("socket()", sock.fileno() >= 0)
sock.close()
# Resolution is local: a name becomes an address in the reserved 240/8 block
# that connect() turns back into the name for the host to dial.
check("getaddrinfo", socket.getaddrinfo("example.com", 443, socket.AF_INET,
                                        socket.SOCK_STREAM)[0][4][1], 443)

anon = mmap.mmap(-1, 4096)
anon[0:5] = b"hello"
check("mmap anonymous", bytes(anon[0:5]), b"hello")

import email, http.server, socketserver, urllib.request, xml.etree.ElementTree
check("blocking-network stdlib", True)
check("asyncio/decimal/json/select", all([asyncio, decimal, json, select]))

if failures:
    print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nall checks passed")
