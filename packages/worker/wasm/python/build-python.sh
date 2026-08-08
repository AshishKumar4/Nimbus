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
#   ./build-python.sh ext sci assets  # rebuild the compiled packages and relink
#
# Outputs, next to this script:
#   python.wasm       the interpreter, stripped, built as a WASI reactor
#   python-sci.wasm   the same interpreter with numpy and markupsafe linked in
#   python313.zip     the stdlib, pyc-only (Tools/wasm/wasm_assets.py)
#   sci-packages.zip  the Python half of the packages in python-sci.wasm
#   pip-*.whl         CPython's bundled pip, staged only when pip actually runs
#
# Two interpreters rather than one because wasm32-wasi has no dlopen, so a
# compiled package is either linked in or unavailable; see EXTENSIONS.md for why
# that beat a runtime dynamic linker. Sessions that install none of the compiled
# packages pay none of the size.
#
# Verified by tests/unit/cpython-wasi-reactor.mjs and cpython-wasi-sci.mjs, which
# drive the artifacts through the Nimbus WASI host.
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

# The compiled packages linked into the "sci" interpreter variant. See
# EXTENSIONS.md: wasm32-wasi has no dlopen, so a compiled package is either in
# the binary or unavailable, and the set is fixed when the variant is linked.
# markupsafe's version is load-bearing — python-pip.ts installs that package's
# Python half from the same sdist, and a _speedups built from a different
# release is a C extension paired with a __init__.py it was never tested with.
MARKUPSAFE_VERSION=3.0.3
NUMPY_VERSION=2.4.3
# Host-side build tools for numpy's meson build. Pinned for the same reason the
# tarballs are: a silent Cython or meson-python bump changes generated C.
MESON_PYTHON_VERSION=0.19.0
CYTHON_VERSION=3.1.4
NINJA_VERSION=1.13.0

PYTHON_SHA=639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690
ZLIB_SHA=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
BZIP2_SHA=ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
XZ_SHA=269e3f2e512cbd3314849982014dc199a7b2148cf5c91cedc6db629acdf5e09b
SQLITE_SHA=a3db587a1b92ee5ddac2f66b3edb41b26f9c867275782d46c3a088977d6a5b18
OPENSSL_SHA=967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99
MARKUPSAFE_SHA=722695808f4b6457b320fdc131280796bdceb04ab50fe1795cd540799ebe1698
NUMPY_SHA=483a201202b73495f00dbc83796c6ae63137a9bdade074f7648b3e32613412dd

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
	fetch_one "https://files.pythonhosted.org/packages/source/m/markupsafe/markupsafe-$MARKUPSAFE_VERSION.tar.gz" "$MARKUPSAFE_SHA"
	fetch_one "https://files.pythonhosted.org/packages/source/n/numpy/numpy-$NUMPY_VERSION.tar.gz" "$NUMPY_SHA"
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
	stage_reactor
}

# Relink the interpreter as a WASI reactor. A command module exports _start and
# WASI says it runs once, which covers `python script.py` and nothing else; a
# REPL has to survive between turns, and a server has to still exist when the
# next request arrives. In workerd that cannot mean a parked wasm stack — a
# request context cannot resume one another request suspended — so it means
# state on the guest heap, reached by entering the VM again. Hence _initialize
# plus named entries, the same shape ruby-runner drives.
#
# The link reuses the Makefile's own resolved variables rather than a second
# copy of them, minus Programs/python.o, which is only there for main().
# Writes the extension table for one variant from its module manifest — lines of
# "<dotted import name> <object>". The base variant's manifest is empty and it
# gets an empty table, so both variants run the same registration path.
#
# The registration is PyImport_AppendInittab and not Modules/Setup because every
# one of these names has a dot in it, and makesetup derives the init symbol as
# PyInit_$name, which stops being a C identifier the moment it does. The init
# symbol is instead the one the module's own source defines, which is
# PyInit_<last component> — numpy._core._multiarray_umath exports
# PyInit__multiarray_umath.
generate_ext_table() {
	local out=$1 manifest=$2
	{
		echo "/* Generated by build-python.sh from $(basename "$manifest"). Do not edit. */"
		echo '#include <Python.h>'
		echo '#include "nimbus-ext.h"'
		echo
		while read -r dotted _; do
			echo "extern PyObject *PyInit_${dotted##*.}(void);"
		done < "$manifest"
		echo
		echo 'static const struct _inittab nimbus_ext_inittab[] = {'
		while read -r dotted _; do
			printf '\t{"%s", PyInit_%s},\n' "$dotted" "${dotted##*.}"
		done < "$manifest"
		printf '\t{NULL, NULL},\n};\n'
		cat <<-'EOF'

		int nimbus_ext_register(void)
		{
			for (const struct _inittab *e = nimbus_ext_inittab; e->name != NULL; e++) {
				if (PyImport_AppendInittab(e->name, e->initfunc) < 0) {
					fprintf(stderr, "nimbus: cannot register extension %s\n", e->name);
					return -1;
				}
			}
			return 0;
		}
		EOF
	} > "$out"
}

# Links one interpreter variant as a WASI reactor. A command module exports
# _start and WASI says it runs once, which covers `python script.py` and nothing
# else; a REPL has to survive between turns, and a server has to still exist when
# the next request arrives. In workerd that cannot mean a parked wasm stack — a
# request context cannot resume one another request suspended — so it means state
# on the guest heap, reached by entering the VM again. Hence _initialize plus
# named entries, the same shape ruby-runner drives.
#
# The link reuses the Makefile's own resolved variables rather than a second copy
# of them, minus Programs/python.o, which is only there for main().
#
# $1 is the output name and $2 the generated extension table; anything after that
# is the variant's extension objects and archives.
link_reactor() {
	local out=$1 table=$2
	shift 2
	printf 'print-%%:\n\t@echo $($*)\n' > "$PYSRC/build-wasi/.printvar.mk"
	( cd "$PYSRC/build-wasi"
	  mkvar() { make -s -f Makefile -f .printvar.mk "print-$1"; }
	  "$CC" --sysroot="$SYSROOT" $(mkvar PY_CORE_LDFLAGS) $(mkvar CFLAGS) \
	    -I"$PYSRC/Include" -I"$PYSRC/Include/internal" -I. -I"$HERE/include" \
	    -c "$HERE/nimbus-py.c" -o nimbus-py.o
	  "$CC" --sysroot="$SYSROOT" $(mkvar PY_CORE_LDFLAGS) $(mkvar CFLAGS) \
	    -I"$PYSRC/Include" -I"$PYSRC/Include/internal" -I. -I"$HERE/include" \
	    -c "$table" -o nimbus-ext.o
	  # No --start-group: wasm-ld rejects the flag and does not need it, because
	  # it resolves archives to a fixed point rather than in one pass.
	  "$CC" --sysroot="$SYSROOT" $(mkvar PY_CORE_LDFLAGS) -mexec-model=reactor \
	    -o "$out" nimbus-py.o nimbus-ext.o "$@" $(mkvar LINK_PYTHON_OBJS) \
	    $(mkvar LIBS) $(mkvar MODLIBS) $(mkvar SYSLIBS) \
	    -Wl,--export=nimbus_py_init -Wl,--export=nimbus_py_run \
	    -Wl,--export=nimbus_py_flush -Wl,--export=malloc -Wl,--export=free )
}

stage_reactor() {
	log "reactor link (base)"
	mkdir -p "$WORK/ext"
	: > "$WORK/ext/base.modules"
	generate_ext_table "$WORK/ext/nimbus-ext-base.c" "$WORK/ext/base.modules"
	link_reactor python.reactor.wasm "$WORK/ext/nimbus-ext-base.c"
}

EXT="$BUILD/work/ext"
NUMPY_SRC="$WORK/numpy-$NUMPY_VERSION"
NUMPY_STAGE="$WORK/numpy-install"
NUMPY_SITE="$NUMPY_STAGE/usr/local/lib/python3.13/site-packages"

# Host-side tools for numpy's meson build. The venv is built from the cross
# build's own host interpreter rather than the machine's python: Cython and
# meson-python then run on the same CPython version the target is, and the
# machine needs no python of any particular vintage.
stage_extenv() {
	log "extension build environment"
	rm -rf "$BUILD/buildenv"
	"$PYSRC/build-host/python" -m venv --without-pip "$BUILD/buildenv"
	PYTHONPATH="$(echo "$PYSRC"/Lib/ensurepip/_bundled/pip-*.whl)" \
	  "$BUILD/buildenv/bin/python" -m pip install -q --no-cache-dir \
	    "meson-python==$MESON_PYTHON_VERSION" "Cython==$CYTHON_VERSION" "ninja==$NINJA_VERSION"
}

# meson cannot probe a wasm32-wasi machine from an x86-64 one, so the target is
# stated. `python` is a wrapper rather than the venv interpreter because meson
# introspects it for EXT_SUFFIX and the include path, and the answer has to be
# the cross build's — which is what _PYTHON_SYSCONFIGDATA_NAME selects, the same
# trick stage_assets already uses for wasm_assets.py.
#
# longdouble_format is supplied because numpy otherwise determines it by running
# a program, which a cross build cannot do. wasm32 reports __LDBL_MANT_DIG__ 113,
# so it is IEEE quad, little-endian.
write_cross_files() {
	mkdir -p "$WORK/cross"
	cat > "$WORK/cross/target-python" <<-EOF
		#!/bin/sh
		export _PYTHON_SYSCONFIGDATA_NAME=_sysconfigdata__wasi_wasm32-wasi
		export PYTHONPATH=$PYSRC/build-wasi/$(cat "$PYSRC/build-wasi/pybuilddir.txt")
		exec $BUILD/buildenv/bin/python "\$@"
	EOF
	for lang in clang clang++; do
		cat > "$WORK/cross/$lang-wrap" <<-EOF
			#!/bin/sh
			NIMBUS_REAL_CC=$WASI_SDK/bin/$lang \\
			exec /usr/bin/env python3 $HERE/meson-wasi-link.py "\$@"
		EOF
	done
	chmod +x "$WORK/cross/target-python" "$WORK/cross/clang-wrap" "$WORK/cross/clang++-wrap"

	local flags="'--target=wasm32-wasi', '--sysroot=$SYSROOT', '-I$PYSRC/Include', '-I$PYSRC/build-wasi', '-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_MMAN', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-D_WASI_EMULATED_GETPID'"
	cat > "$WORK/cross/wasi.ini" <<-EOF
		[binaries]
		c = '$WORK/cross/clang-wrap'
		cpp = '$WORK/cross/clang++-wrap'
		ar = '$AR'
		ranlib = '$RANLIB'
		strip = '$STRIP'
		python = '$WORK/cross/target-python'

		[host_machine]
		system = 'wasi'
		cpu_family = 'wasm32'
		cpu = 'wasm32'
		endian = 'little'

		[properties]
		longdouble_format = 'IEEE_QUAD_LE'
		needs_exe_wrapper = true

		[built-in options]
		c_args = [$flags]
		cpp_args = [$flags]
		c_link_args = ['--target=wasm32-wasi', '--sysroot=$SYSROOT']
		cpp_link_args = ['--target=wasm32-wasi', '--sysroot=$SYSROOT']
	EOF
}

# distributions.c is compiled twice by numpy and the two builds are not
# interchangeable; patch 0003 gives the legacy one its own namespace using this
# header. The rename set is the symbol table of a throwaway non-legacy compile of
# distributions.c, not a reading of distributions.h: random_geometric_inversion
# is defined in the .c and declared in no header at all, so a set derived from
# declarations misses it and the collision comes back at link time.
#
# Runs after meson setup, which is what generates the numpyconfig.h this needs.
generate_legacy_rename_header() {
	"$CC" $TARGET_CFLAGS -I"$NUMPY_SRC/numpy/_core/include" -I"$NUMPY_SRC/numpy/random/src" \
	  -I"$NUMPY_SRC/builddir/numpy/_core" -I"$PYSRC/Include" -I"$PYSRC/build-wasi" \
	  -c "$NUMPY_SRC/numpy/random/src/distributions/distributions.c" -o "$WORK/distributions-probe.o"
	local names count
	names=$("$WASI_SDK/bin/llvm-nm" --defined-only "$WORK/distributions-probe.o" | awk '$2 == "T" { print $3 }' | sort -u)
	count=$(echo "$names" | wc -l)
	[ "$count" -ge 50 ] || { echo "ERROR: only $count symbols in distributions.c" >&2; exit 1; }
	{
		echo '/* Generated by build-python.sh. Do not edit. */'
		echo '#ifndef NIMBUS_LEGACY_RENAME_H'
		echo '#define NIMBUS_LEGACY_RENAME_H'
		echo
		echo "$names" | sed 's/.*/#define & nimbus_legacy_&/'
		echo
		echo '#endif'
	} > "$NUMPY_SRC/numpy/random/src/legacy/nimbus-legacy-rename.h"
	echo "  $count legacy random symbols renamed"
}

stage_ext() {
	log "extensions: markupsafe $MARKUPSAFE_VERSION"
	mkdir -p "$EXT"
	rm -rf "$WORK/markupsafe-$MARKUPSAFE_VERSION"
	tar xzf "$SRC/markupsafe-$MARKUPSAFE_VERSION.tar.gz" -C "$WORK"
	# One self-contained C file against the CPython API; no build system needed.
	"$CC" $TARGET_CFLAGS -D_GNU_SOURCE=1 \
	  -I"$HERE/include" -include "$HERE/include/nimbus-net.h" \
	  -include "$HERE/include/nimbus-wasi-compat.h" \
	  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
	  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
	  -I"$PYSRC/Include" -I"$PYSRC/build-wasi" \
	  -c "$WORK/markupsafe-$MARKUPSAFE_VERSION/src/markupsafe/_speedups.c" \
	  -o "$EXT/markupsafe_speedups.o"

	log "extensions: numpy $NUMPY_VERSION"
	rm -rf "$NUMPY_SRC" "$NUMPY_STAGE"
	tar xzf "$SRC/numpy-$NUMPY_VERSION.tar.gz" -C "$WORK"
	( cd "$NUMPY_SRC"
	  patch -p1 -s < "$HERE/patches/0002-numpy-share-one-reference-lapack.patch"
	  patch -p1 -s < "$HERE/patches/0003-numpy-namespace-the-legacy-random-build.patch" )
	write_cross_files
	# numpy vendors its own meson: the build needs meson's `features` module,
	# which upstream meson does not have. -Dallow-noblas because no optimised
	# BLAS exists for this target — the bundled f2c'd reference LAPACK is used,
	# which is what Pyodide ships too.
	( cd "$NUMPY_SRC"
	  export PATH="$BUILD/buildenv/bin:$PATH"
	  "$BUILD/buildenv/bin/python" vendored-meson/meson/meson.py setup builddir \
	    --cross-file "$WORK/cross/wasi.ini" -Dallow-noblas=true --prefix=/usr/local >/dev/null
	  generate_legacy_rename_header
	  "$BUILD/buildenv/bin/ninja" -C builddir -j"$(nproc)" >/dev/null
	  # The tests tag is left out: numpy's test suite is megabytes of Python that
	  # cannot run here anyway, and meson already knows which files it covers.
	  "$BUILD/buildenv/bin/python" vendored-meson/meson/meson.py install -C builddir \
	    --destdir "$NUMPY_STAGE" --tags runtime,python-runtime >/dev/null )

	# The module set is discovered from what was built, not declared here, so a
	# module numpy adds or drops cannot silently go missing from the variant.
	# meson wrote each one with a .so name; they are relocatable objects, not
	# shared libraries (see meson-wasi-link.py). They are copied out under their
	# dotted names before stage_assets strips them from the tree that ships.
	rm -rf "$EXT/numpy"
	mkdir -p "$EXT/numpy"
	: > "$EXT/sci.modules"
	( cd "$NUMPY_SITE" && find . -name "*.cpython-313-wasm32-wasi.so" | sed 's|^\./||' | sort ) \
	  | while read -r rel; do
		local dotted="${rel%.cpython-313-wasm32-wasi.so}"
		dotted=$(echo "$dotted" | tr / .)
		cp "$NUMPY_SITE/$rel" "$EXT/numpy/$dotted.o"
		printf '%s %s\n' "$dotted" "$EXT/numpy/$dotted.o" >> "$EXT/sci.modules"
	  done
	echo "markupsafe._speedups $EXT/markupsafe_speedups.o" >> "$EXT/sci.modules"
	echo "  $(wc -l < "$EXT/sci.modules") extension modules"
}

stage_sci() {
	log "reactor link (sci)"
	generate_ext_table "$EXT/nimbus-ext-sci.c" "$EXT/sci.modules"
	# The extension objects reference numpy's internal archives, which the meson
	# link deliberately left out of each module; they are added here, once.
	local objs archives
	objs=$(cut -d' ' -f2 "$EXT/sci.modules" | tr '\n' ' ')
	archives=$(find "$NUMPY_SRC/builddir" -name '*.a' | tr '\n' ' ')
	# -lc-printscan-long-double: wasi-libc's default printf aborts on a long
	# double rather than formatting one, and numpy formats one while importing.
	# The abort is a bare wasm trap; the reason only reaches stderr because
	# wasi-libc prints it first.
	# shellcheck disable=SC2086 -- both lists are build-produced paths.
	link_reactor python.sci.wasm "$EXT/nimbus-ext-sci.c" \
	  $objs $archives "$HERE/nimbus-cxx-noeh.c" \
	  -lc-printscan-long-double -lc++ -lc++abi
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
	"$STRIP" "$PYSRC/build-wasi/python.reactor.wasm" -o "$HERE/python.wasm"
	cp "$PYSRC/build-wasi/usr/local/lib/python$PYTHON_XY.zip" "$HERE/python$PYTHON_XY.zip"
	cp "$PYSRC/Lib/ensurepip/_bundled"/pip-*.whl "$HERE/"

	# The sci variant's Python half. Its compiled half is inside python-sci.wasm,
	# so the .so files meson installed — relocatable objects, not loadable —
	# are dropped rather than shipped as several dead megabytes.
	"$STRIP" "$PYSRC/build-wasi/python.sci.wasm" -o "$HERE/python-sci.wasm"
	find "$NUMPY_SITE" -name '*.so' -delete
	find "$NUMPY_SITE" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
	( cd "$NUMPY_SITE" && "$BUILD/buildenv/bin/python" - "$HERE/sci-packages.zip" <<-'PYEOF'
		import pathlib
		import sys
		import zipfile

		with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
			for path in sorted(pathlib.Path('.').rglob('*')):
				if path.is_file():
					archive.write(path, path.as_posix())
	PYEOF
	)
	log "built"
	ls -l "$HERE/python.wasm" "$HERE/python-sci.wasm" "$HERE/python$PYTHON_XY.zip" \
	  "$HERE/sci-packages.zip" "$HERE"/pip-*.whl
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
	# Nothing but preview1 may be imported: the artifacts have to stay stock WASI
	# modules that any conforming host can instantiate. Both variants, because
	# the sci one links C++ and a second libc, either of which could drag in an
	# import the base build never had.
	local variant ns
	for variant in python.wasm python-sci.wasm; do
		ns=$(node -e "
		  const m = new WebAssembly.Module(require('fs').readFileSync('$HERE/$variant'));
		  const s = new Set(WebAssembly.Module.imports(m).map(i => i.module));
		  process.stdout.write([...s].sort().join(','));")
		echo "  $variant import namespaces: $ns"
		[ "$ns" = "wasi_snapshot_preview1" ] || {
			echo "ERROR: unexpected import namespace in $variant" >&2; exit 1; }
	done

	# The sci variant's extensions have to be registered under the dotted names
	# the packages import them by. A build that linked the objects but lost the
	# inittab entry still links and still runs everything else.
	local want got
	want=$(cut -d' ' -f1 "$EXT/sci.modules" | sort)
	got=$(grep -o '{"[a-z0-9_.]*", PyInit' "$EXT/nimbus-ext-sci.c" | sed 's/{"//; s/", PyInit//' | sort)
	[ "$want" = "$got" ] || {
		echo "ERROR: the sci inittab does not match the module set" >&2
		diff <(echo "$want") <(echo "$got") >&2 || true
		exit 1; }
	echo "  sci inittab covers all $(echo "$want" | wc -l) modules"

	# Static checks cannot tell a module that was built from one that works, and
	# the interpreter is a reactor, so there is no _start to run and no
	# `wasmtime run` that means anything. The behaviour tests drive the same entry
	# points the runner calls, against the real WASI host from
	# runtime/wasi/preamble.ts rather than a stand-in. The sci one imports numpy
	# and markupsafe._speedups for real and checks results, because "it linked"
	# says nothing about whether the extensions initialise.
	( cd "$HERE/../../../.." && bun tests/unit/cpython-wasi-reactor.mjs \
	  && bun tests/unit/cpython-wasi-sci.mjs )
}

stages=("$@")
if [ ${#stages[@]} -eq 0 ]; then
	# stage_wasi links the base variant itself, so `reactor` is not listed here.
	stages=(fetch deps nimbus hostpy wasi extenv ext sci assets verify)
fi
for stage in "${stages[@]}"; do
	"stage_$stage"
done
