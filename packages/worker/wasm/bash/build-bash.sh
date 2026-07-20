#!/usr/bin/env bash
# Build unmodified GNU bash 5.2 -> wasm32-wasi + the Nimbus fork/exec/pipe layer.
# Reproducible off-platform recipe (REAL-FORK-BASH-PLAN §3 route 2). Presented
# as-is, maintained by Claude. Requires: wasi-sdk >= 24, a host cc (build tools).
#
# Status (2026-07-20): configure SUCCEEDS; bash core objects compile to wasm
# (general.o, eval.o verified; shell/execute_cmd/subst compile once generated
# headers exist). Remaining to a running bash.wasm: (1) let the real Makefile
# drive the target build with these flags (build tools native, target with
# SjLj+overlay); (2) link with nimbus-proc.o + __wasm_setjmp/__wasm_longjmp;
# (3) wasm-opt --asyncify the nimbus_proc blocking imports. See BRINGUP.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
: "${BASH_SRC:?set BASH_SRC to an extracted bash-5.2.x source tree}"
CC="$WASI_SDK/bin/wasm32-wasi-clang"

# -std=gnu17 keeps GCC-15/clang-19 (C23 default) from rejecting bash 5.2's K&R
# prototypes; the emulated-feature libs; and the Nimbus overlay header, which
# REPLACES setjmp.h with the asyncify-native setjmp/longjmp — so we do NOT use
# clang's -wasm-enable-sjlj (its wasm-EH output is not asyncify-instrumentable;
# proven, see BRINGUP.md). The module stays EH-free → wasm-opt --asyncify works.
TARGET_CFLAGS="-std=gnu17 -O2 \
  -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  -include $HERE/nimbus-proc.h \
  -Wno-implicit-function-declaration -Wno-incompatible-function-pointer-types \
  -Wno-incompatible-pointer-types -Wno-int-conversion"
TARGET_LDFLAGS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman"

INC="-I$HERE/include"   # Nimbus termios.h overlay

cd "$BASH_SRC"
if [ ! -f config.status ]; then
  CC="$CC" \
  CFLAGS="-std=gnu17 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -O2" \
  CPPFLAGS="-D_GNU_SOURCE" LDFLAGS="$TARGET_LDFLAGS" \
  ./configure --host=wasm32-wasi --without-bash-malloc --disable-nls \
    --cache-file="$HERE/cross.cache"
  # config.h fixes: wasi-libc HAS gethostname/tcgetattr/tcgetpgrp/termios;
  # struct passwd comes from the overlay (no <pwd.h> file) so keep HAVE_PWD_H
  # off but HAVE_GETPWNAM on. HAVE_TERMIOS_H + HAVE_TCGETATTR make config-bot.h
  # pick the termios tty driver (not the absent BSD sgtty one).
  sed -i 's|/\* #undef HAVE_GETHOSTNAME \*/|#define HAVE_GETHOSTNAME 1|;
          s|/\* #undef HAVE_GETPWNAM \*/|#define HAVE_GETPWNAM 1|;
          s|/\* #undef HAVE_TERMIOS_H \*/|#define HAVE_TERMIOS_H 1|;
          s|/\* #undef HAVE_TCGETATTR \*/|#define HAVE_TCGETATTR 1|;
          s|/\* #undef HAVE_TCGETPGRP \*/|#define HAVE_TCGETPGRP 1|' config.h
  # Portability: readline uses the bundled termcap lib's PC/BC/UP storage
  # (clang -fno-common default + a broken -fcommon on wasm ⇒ extern the copies).
  sed -i '109s/^char PC, \*BC, \*UP;/extern char PC, *BC, *UP;/' lib/readline/terminal.c
fi

TARGET_CFLAGS="$TARGET_CFLAGS $INC"
# Build tools NATIVE (gcc -std=gnu17 for bash's K&R). Target with the Nimbus flags.
make -j"$(nproc)" CC_FOR_BUILD='gcc -std=gnu17' CFLAGS="$TARGET_CFLAGS" LOCAL_LIBS="" \
  || echo "make compiles all objects; final link is done explicitly below"

# nimbus-proc.o: the process/setjmp/termios/signal trap layer linked into bash.
"$CC" -std=gnu17 -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS $INC -O2 \
  -c "$HERE/nimbus-proc.c" -o "$HERE/nimbus-proc.o"

# Explicit link. --no-gc-sections is REQUIRED: bash's main() is K&R 3-arg, so the
# wasi crt's weak __main_argc_argv→main link doesn't root it under gc-sections and
# the whole shell gets stripped to a 10-import stub. Overlay passed exactly once.
OBJS="shell.o eval.o y.tab.o general.o make_cmd.o print_cmd.o dispose_cmd.o execute_cmd.o \
  variables.o copy_cmd.o error.o expr.o flags.o jobs.o subst.o hashcmd.o hashlib.o mailcheck.o \
  trap.o input.o unwind_prot.o pathexp.o sig.o test.o version.o alias.o array.o arrayfunc.o \
  assoc.o braces.o bracecomp.o bashhist.o bashline.o list.o stringlib.o locale.o findcmd.o \
  redir.o pcomplete.o pcomplib.o syntax.o xmalloc.o signames.o"
"$CC" -O2 -o bash $OBJS \
  -L./builtins -L./lib/readline -L./lib/glob -L./lib/tilde -L./lib/sh \
  -lbuiltins -lglob -lsh -lreadline -lhistory ./lib/termcap/libtermcap.a -ltilde \
  "$HERE/nimbus-proc.o" $TARGET_LDFLAGS \
  -Wl,--export=__stack_pointer -Wl,--allow-undefined -Wl,--no-gc-sections

# fpcast-emu: bash's unwind_protect casts function pointers, which wasm's
# type-checked call_indirect rejects at runtime (traps after the command runs).
# Binaryen's --fpcast-emu boxes indirect calls to a uniform signature (like
# Emscripten's EMULATE_FUNCTION_POINTER_CASTS) — REQUIRED for bash to exit clean.
wasm-opt --fpcast-emu bash -o bash.fpc.wasm

# Asyncify: setjmp/longjmp ride the allowlist alongside the process calls — they
# unwind (capture) / rewind (longjmp) exactly like fork/exec/wait. The binary is
# EH-free (asyncify-native setjmp, NOT clang -wasm-enable-sjlj) so this succeeds.
wasm-opt --asyncify \
  --pass-arg=asyncify-imports@nimbus_proc.fork,nimbus_proc.vfork,nimbus_proc.execve,nimbus_proc.waitpid,nimbus_proc.setjmp,nimbus_proc.longjmp \
  bash.fpc.wasm -o bash.async.wasm

echo "Built: $BASH_SRC/bash (linked) + $BASH_SRC/bash.async.wasm (asyncified)"
echo "Imports: 24 wasi_snapshot_preview1 + 15 nimbus_proc + 8 env (getpid/umask/setuid/setgid/dl*)"
