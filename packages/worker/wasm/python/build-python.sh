#!/usr/bin/env bash
# Build CPython 3.13 -> wasm32-wasi with the C libraries the published
# wasm32-wasi artifacts leave out. Reproducible off-platform recipe, presented
# as-is, maintained by Claude. Requires: wasi-sdk >= 25, a host toolchain
# (cc/make/perl/pkg-config), and network access for the pinned source tarballs.
#
# Why this exists: brettcannon/cpython-wasi-build ships a working interpreter
# with ZLIB MISSING, so zipfile cannot inflate and the entire wheel/pip path is
# dead. _ssl, _hashlib, _lzma, _bz2 and _sqlite3 are absent for the same reason
# — nobody cross-built the dependencies. They are all portable C.
#
#   ./build-python.sh                 # everything
#   ./build-python.sh deps            # just the C dependencies
#   ./build-python.sh wasi assets     # re-link the interpreter and repack
#
# Outputs, next to this script:
#   python.wasm    the interpreter, stripped
#   python313.zip  the stdlib, pyc-only (Tools/wasm/wasm_assets.py)
#   pip-*.whl      CPython's bundled pip, staged only when pip actually runs
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/clang, share/wasi-sysroot)}"
BUILD="${BUILD:-$HERE/build}"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
SRC="$BUILD/src"
WORK="$BUILD/work"
DEPS="$BUILD/deps"

CC="$WASI_SDK/bin/clang"
AR="$WASI_SDK/bin/llvm-ar"
RANLIB="$WASI_SDK/bin/llvm-ranlib"
STRIP="$WASI_SDK/bin/llvm-strip"
TARGET_CFLAGS="--target=wasm32-wasi --sysroot=$SYSROOT -O2"

PYTHON_VERSION=3.13.14
PYTHON_XY=313
ZLIB_VERSION=1.3.1
BZIP2_VERSION=1.0.8
XZ_VERSION=5.6.4
SQLITE_VERSION=3500400
OPENSSL_VERSION=3.5.4

PYTHON_SHA=639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690
ZLIB_SHA=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
BZIP2_SHA=ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
XZ_SHA=269e3f2e512cbd3314849982014dc199a7b2148cf5c91cedc6db629acdf5e09b
SQLITE_SHA=a3db587a1b92ee5ddac2f66b3edb41b26f9c867275782d46c3a088977d6a5b18
OPENSSL_SHA=967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99

PYSRC="$WORK/Python-$PYTHON_VERSION"

log() { printf '\n=== %s ===\n' "$*"; }

fetch_one() {
	local url=$1 want=$2 file="$SRC/$(basename "$1")"
	if [ ! -f "$file" ]; then
		mkdir -p "$SRC"
		curl -sSLf -o "$file" "$url"
	fi
	echo "$want  $file" | sha256sum -c - >/dev/null
}

stage_fetch() {
	log "fetch"
	fetch_one "https://www.python.org/ftp/python/$PYTHON_VERSION/Python-$PYTHON_VERSION.tar.xz" "$PYTHON_SHA"
	fetch_one "https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA"
	fetch_one "https://sourceware.org/pub/bzip2/bzip2-$BZIP2_VERSION.tar.gz" "$BZIP2_SHA"
	fetch_one "https://github.com/tukaani-project/xz/releases/download/v$XZ_VERSION/xz-$XZ_VERSION.tar.gz" "$XZ_SHA"
	fetch_one "https://www.sqlite.org/2025/sqlite-autoconf-$SQLITE_VERSION.tar.gz" "$SQLITE_SHA"
	fetch_one "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_SHA"
}

# A .pc file for each dependency, so CPython's PKG_CHECK_MODULES finds the
# cross-built libraries without a cross pkg-config wrapper.
write_pc() {
	local name=$1 version=$2 lib=$3
	mkdir -p "$DEPS/lib/pkgconfig"
	cat > "$DEPS/lib/pkgconfig/$name.pc" <<-EOF
		prefix=$DEPS
		libdir=\${prefix}/lib
		includedir=\${prefix}/include
		Name: $name
		Description: $name for wasm32-wasi (static, built by build-python.sh)
		Version: $version
		Libs: -L\${libdir} -l$lib
		Cflags: -I\${includedir}
	EOF
}

# Exports the cross toolchain. Called inside each dependency's subshell rather
# than at stage scope, so the native build-python configure that runs later in
# the same shell still sees the host compiler.
wasi_env() {
	export CC AR RANLIB
	export CFLAGS="$TARGET_CFLAGS"
}

stage_deps() {
	mkdir -p "$DEPS/lib" "$DEPS/include" "$WORK"

	log "zlib $ZLIB_VERSION"
	rm -rf "$WORK/zlib-$ZLIB_VERSION"
	tar xzf "$SRC/zlib-$ZLIB_VERSION.tar.gz" -C "$WORK"
	( cd "$WORK/zlib-$ZLIB_VERSION" && wasi_env
	  CHOST=wasm32-wasi ./configure --static --prefix="$DEPS" >/dev/null
	  make -j"$(nproc)" libz.a >/dev/null && make install >/dev/null )

	log "bzip2 $BZIP2_VERSION"
	rm -rf "$WORK/bzip2-$BZIP2_VERSION"
	tar xzf "$SRC/bzip2-$BZIP2_VERSION.tar.gz" -C "$WORK"
	( cd "$WORK/bzip2-$BZIP2_VERSION"
	  make libbz2.a CC="$CC" AR="$AR" RANLIB="$RANLIB" \
	       CFLAGS="$TARGET_CFLAGS -D_FILE_OFFSET_BITS=64" >/dev/null
	  cp libbz2.a "$DEPS/lib/" && cp bzlib.h "$DEPS/include/" )
	write_pc bzip2 "$BZIP2_VERSION" bz2

	log "xz $XZ_VERSION"
	rm -rf "$WORK/xz-$XZ_VERSION"
	tar xzf "$SRC/xz-$XZ_VERSION.tar.gz" -C "$WORK"
	( cd "$WORK/xz-$XZ_VERSION" && wasi_env
	  ./configure --host=wasm32-wasi --prefix="$DEPS" --disable-shared --enable-static \
	    --disable-xz --disable-xzdec --disable-lzmadec --disable-lzmainfo \
	    --disable-scripts --disable-doc --disable-threads --disable-nls >/dev/null
	  make -j"$(nproc)" >/dev/null && make install >/dev/null )

	# The amalgamation is compiled directly rather than through sqlite's
	# configure: the defines are the interesting part. WAL and mmap need shared
	# memory WASI does not have, and the default unix VFS locks with
	# fcntl(F_SETLK), which wasi-libc does not implement — unix-none is the
	# no-op-locking VFS, correct for a single-process guest.
	log "sqlite $SQLITE_VERSION"
	rm -rf "$WORK/sqlite-autoconf-$SQLITE_VERSION"
	tar xzf "$SRC/sqlite-autoconf-$SQLITE_VERSION.tar.gz" -C "$WORK"
	( cd "$WORK/sqlite-autoconf-$SQLITE_VERSION"
	  "$CC" $TARGET_CFLAGS -c sqlite3.c -o sqlite3.o \
	    -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION=1 -DSQLITE_OMIT_WAL=1 \
	    -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DEFAULT_UNIX_VFS='"unix-none"' \
	    -DSQLITE_ENABLE_FTS5=1 -DSQLITE_ENABLE_RTREE=1 -DSQLITE_ENABLE_MATH_FUNCTIONS=1 \
	    -DSQLITE_ENABLE_COLUMN_METADATA=1 -DSQLITE_ENABLE_DBSTAT_VTAB=1 \
	    -DSQLITE_OMIT_POPEN=1 -DHAVE_POSIX_FALLOCATE=0
	  "$AR" rcs "$DEPS/lib/libsqlite3.a" sqlite3.o
	  cp sqlite3.h sqlite3ext.h "$DEPS/include/" )
	write_pc sqlite3 "3.50.4" sqlite3

	# linux-generic32 is the closest upstream target: no assembly, no DSO, and a
	# plain read()/write() socket BIO, which is exactly what the Nimbus WASI
	# host's descriptors support. Threads stay ENABLED — wasi-libc ships
	# single-threaded pthread stubs, so OPENSSL_THREADS is true and CPython's
	# "Python requires thread-safe OpenSSL" guard is satisfied honestly. The
	# thread pool is the one part that needs real threads, hence no-thread-pool.
	log "openssl $OPENSSL_VERSION"
	rm -rf "$WORK/openssl-$OPENSSL_VERSION"
	tar xzf "$SRC/openssl-$OPENSSL_VERSION.tar.gz" -C "$WORK"
	( cd "$WORK/openssl-$OPENSSL_VERSION"
	  CC="$CC" AR="$AR" RANLIB="$RANLIB" \
	  CFLAGS="$TARGET_CFLAGS -I$HERE/include -include $HERE/include/nimbus-net.h \
	    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS \
    -D_WASI_EMULATED_GETPID -DOPENSSL_NO_SECURE_MEMORY -DOPENSSL_NO_UNIX_SOCK \
	    -DNO_SYSLOG" \
	  ./Configure linux-generic32 \
	    no-asm no-shared no-dso no-engine no-tests no-apps no-docs no-afalgeng \
	    no-ui-console no-legacy no-module no-autoload-config no-quic no-thread-pool \
	    --with-rand-seed=getrandom --prefix="$DEPS" --openssldir="$DEPS/ssl" >/dev/null
	  make -j"$(nproc)" build_libs >/dev/null
	  make install_dev >/dev/null )
}

stage_nimbus() {
	log "libnimbuswasi.a"
	mkdir -p "$WORK/nimbus"
	for unit in nimbus-net nimbus-wasi-compat; do
		"$CC" $TARGET_CFLAGS -std=c11 -Wall -Wextra -Werror \
		  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN \
		  -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
		  -I"$HERE/include" -include "$HERE/include/nimbus-net.h" \
		  -include "$HERE/include/nimbus-wasi-compat.h" \
		  -c "$HERE/$unit.c" -o "$WORK/nimbus/$unit.o"
	done
	"$AR" rcs "$DEPS/lib/libnimbuswasi.a" "$WORK/nimbus"/*.o
}

# CPython's cross build runs the same-version interpreter for freezing and for
# wasm_assets.py, and refuses a mismatch — so the host build is not optional.
stage_hostpy() {
	log "build-python $PYTHON_VERSION (native)"
	rm -rf "$PYSRC"
	tar xf "$SRC/Python-$PYTHON_VERSION.tar.xz" -C "$WORK"
	( cd "$PYSRC" && patch -p1 -s < "$HERE/patches/0001-pthread-stubs-support-tls-destructors.patch" )
	mkdir -p "$PYSRC/build-host"
	( cd "$PYSRC/build-host"
	  ../configure --prefix="$BUILD/hostpy" --with-ensurepip=no >/dev/null
	  make -j"$(nproc)" >/dev/null )
}

stage_wasi() {
	log "CPython $PYTHON_VERSION (wasm32-wasi)"
	rm -rf "$PYSRC/build-wasi" && mkdir -p "$PYSRC/build-wasi"
	( cd "$PYSRC/build-wasi"
	  # autoconf accepts a list; ours refines CPython's rather than forking it.
	  export CONFIG_SITE="$PYSRC/Tools/wasm/config.site-wasm32-wasi $HERE/config.site-nimbus-wasi"
	  export PKG_CONFIG_LIBDIR="$DEPS/lib/pkgconfig" PKG_CONFIG_PATH="$DEPS/lib/pkgconfig"
	  export CC="$CC --sysroot=$SYSROOT" CPP="$WASI_SDK/bin/clang-cpp --sysroot=$SYSROOT"
	  export AR RANLIB
	  # -D_GNU_SOURCE ahead of the forced includes: pyconfig.h sets it too, but
	  # by then the overlay has already pulled in the system headers.
	  export CFLAGS="--target=wasm32-wasi -D_GNU_SOURCE=1 -O2 \
	    -I$HERE/include -include $HERE/include/nimbus-net.h \
	    -include $HERE/include/nimbus-wasi-compat.h -I$DEPS/include \
	    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
	    -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
	  # --wrap lets nimbus-net own accept and close without colliding with the
	  # wasi-libc definitions that are still in the archive.
	  export LDFLAGS="--target=wasm32-wasi -L$DEPS/lib \
	    -Wl,--wrap=close -Wl,--wrap=accept -Wl,--wrap=accept4"
	  export LIBS="-lnimbuswasi -lwasi-emulated-signal -lwasi-emulated-process-clocks \
	    -lwasi-emulated-mman -lwasi-emulated-getpid"
	  mkdir -p Modules && cp "$HERE/Setup.local" Modules/Setup.local
	  ../configure -C --host=wasm32-wasi --build=x86_64-pc-linux-gnu \
	    --with-build-python="$PYSRC/build-host/python" \
	    --with-openssl="$DEPS" --with-ensurepip=no \
	    --disable-test-modules --disable-ipv6 >/dev/null
	  make -j"$(nproc)" >/dev/null )
}

stage_assets() {
	log "assets"
	# wasm_assets.py reads sysconfig from whichever interpreter runs it, and the
	# one that can run is the host build — so point it at the cross data.
	( cd "$PYSRC/build-wasi"
	  _PYTHON_SYSCONFIGDATA_NAME=_sysconfigdata__wasi_wasm32-wasi \
	  PYTHONPATH="$(cat pybuilddir.txt)" \
	  "$PYSRC/build-host/python" "$PYSRC/Tools/wasm/wasm_assets.py" \
	    --buildroot . --prefix /usr/local )
	"$STRIP" "$PYSRC/build-wasi/python.wasm" -o "$HERE/python.wasm"
	cp "$PYSRC/build-wasi/usr/local/lib/python$PYTHON_XY.zip" "$HERE/python$PYTHON_XY.zip"
	cp "$PYSRC/Lib/ensurepip/_bundled"/pip-*.whl "$HERE/"
	log "built"
	ls -l "$HERE/python.wasm" "$HERE/python$PYTHON_XY.zip" "$HERE"/pip-*.whl
}

# The batteries are the whole point of this build, and configure records a
# dependency it cannot link as "missing" rather than failing — a duplicate
# symbol in one probe program is enough to drop _ssl and _hashlib from an
# otherwise successful build. So the required set is asserted, not assumed.
REQUIRED_MODULES="ZLIB _BZ2 _LZMA _SSL _HASHLIB _SQLITE3 _SOCKET _DECIMAL _ASYNCIO PYEXPAT"

# Functions whose autoconf probe cannot survive the overlay headers, answered in
# config.site-nimbus-wasi. Asserted here so a stale override shows up as a build
# failure rather than as a missing attribute at runtime.
REQUIRED_FUNCS="GETUID GETEUID GETGID GETEGID UMASK SOCKET SHUTDOWN GETPEERNAME ACCEPT4 \
GETADDRINFO LSTAT FSTATAT MKDIRAT FUTIMENS UTIMENSAT READLINK SYMLINK"

stage_verify() {
	log "verify"
	local data
	data="$PYSRC/build-wasi/$(cat "$PYSRC/build-wasi/pybuilddir.txt")/_sysconfigdata__wasi_wasm32-wasi.py"
	local failed=0
	for mod in $REQUIRED_MODULES; do
		local state
		state=$(sed -n "s/.*'MODULE_${mod}_STATE': '\([a-z\/]*\)'.*/\1/p" "$data")
		printf '  MODULE_%-12s %s\n' "$mod" "${state:-<absent>}"
		[ "$state" = "yes" ] || failed=1
	done
	for fn in $REQUIRED_FUNCS; do
		if grep -q "^#define HAVE_$fn 1" "$PYSRC/build-wasi/pyconfig.h"; then
			printf '  HAVE_%-14s yes\n' "$fn"
		else
			printf '  HAVE_%-14s NO\n' "$fn"
			failed=1
		fi
	done
	if [ "$failed" -ne 0 ]; then
		echo "ERROR: a required module or function is missing; see build-wasi/config.log" >&2
		exit 1
	fi
	# Nothing but preview1 may be imported: the artifact has to stay a stock
	# WASI module that any conforming host can instantiate.
	local ns
	ns=$(node -e "
	  const m = new WebAssembly.Module(require('fs').readFileSync('$HERE/python.wasm'));
	  const s = new Set(WebAssembly.Module.imports(m).map(i => i.module));
	  process.stdout.write([...s].sort().join(','));")
	echo "  import namespaces: $ns"
	[ "$ns" = "wasi_snapshot_preview1" ] || {
		echo "ERROR: unexpected import namespace" >&2; exit 1; }

	# Static checks cannot tell a module that was built from one that works.
	# wasmtime is the off-platform arm; the Nimbus arm is the behavioural suite.
	if command -v wasmtime >/dev/null 2>&1; then
		local root="$BUILD/gate"
		rm -rf "$root"
		mkdir -p "$root/usr/local/lib/python$PYTHON_XY" "$root/work"
		mkdir -p "$root/usr/local/lib/python${PYTHON_VERSION%.*}/lib-dynload"
		touch "$root/usr/local/lib/python${PYTHON_VERSION%.*}/lib-dynload/.empty"
		cp "$HERE/python$PYTHON_XY.zip" "$root/usr/local/lib/"
		cp "$PYSRC/Lib/os.py" "$root/usr/local/lib/python${PYTHON_VERSION%.*}/"
		cp "$HERE/gate.py" "$root/work/"
		wasmtime run --dir "$root::/" "$HERE/python.wasm" -E /work/gate.py
	else
		echo "  gate.py SKIPPED: wasmtime not on PATH" >&2
	fi
}

stages=("$@")
if [ ${#stages[@]} -eq 0 ]; then
	stages=(fetch deps nimbus hostpy wasi assets verify)
fi
for stage in "${stages[@]}"; do
	"stage_$stage"
done
