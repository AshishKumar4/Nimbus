#!/usr/bin/env python3
"""Compiler driver that lets meson build Python extension modules for wasm32-wasi.

meson builds a py.extension_module as a shared object. wasm32-wasi has no dlopen
and these objects are not position-independent, so that link cannot succeed and
would not be loadable if it did. Those links — identified by -shared, which only
they carry — are turned into *relocatable* objects instead: one .o per extension
module, which build-python.sh then links into the interpreter statically.

Two details are load-bearing.

Everything without -shared is passed through untouched. meson detects a function
by taking its address and linking a test program, and a relocatable link tolerates
undefined symbols — so rewriting those links too made every probe answer YES.
That is how HAVE_BACKTRACE came out true against a sysroot that has no backtrace,
which then compiled numpy's dladdr-based temporary-array elision for a target
whose dlfcn.h declares neither dladdr nor Dl_info. The build failed loudly there;
the same mistake in a probe whose answer only changes behaviour would not have.

Archives and -l libraries are dropped from the relocatable link. Under -r the
linker copies in every archive member it resolves, so libnpymath.a landing inside
two module objects would be a duplicate-symbol error at the final link. They are
added once, there, instead.
"""
import os
import subprocess
import sys

REAL = os.environ['NIMBUS_REAL_CC']

# -shared is removed because that is the link being replaced; the rest are flags
# wasm-ld does not accept, or that mean nothing for a relocatable output.
DROP = {'-shared', '-Wl,--start-group', '-Wl,--end-group', '--start-group',
        '--end-group', '-Wl,--gc-sections', '-Wl,--no-undefined', '-rdynamic'}


def main(argv: list[str]) -> int:
    if '-shared' not in argv:
        return subprocess.call([REAL, *argv])

    kept = [
        a for a in argv
        if a not in DROP
        and not a.endswith('.a')
        and not (a.startswith('-l') and a != '-l')
        and not a.startswith('-Wl,-soname')
        and not a.startswith('-Wl,--version-script')
    ]
    return subprocess.call([REAL, '-r', '-nostdlib', *kept])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
