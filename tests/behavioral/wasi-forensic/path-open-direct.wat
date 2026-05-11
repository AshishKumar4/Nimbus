;; path-open-direct.wat — handcrafted WASI forensic probe.
;;
;; Bypasses wasi-libc entirely. Calls path_open(fd=3, ...) DIRECTLY with
;; explicit full rights (rights_base=0xFFFFFFFFFFFFFFFF, rights_inheriting=
;; 0xFFFFFFFFFFFFFFFF) and O_CREAT|O_WRONLY|O_TRUNC oflags, then writes
;; the result errno to stdout as ASCII so the host probe can read it.
;;
;; Two variants assembled from this WAT differing ONLY in the wasi import
;; module name:
;;
;;   path-open-direct.preview1.wasm   — imports wasi_snapshot_preview1.path_open
;;   path-open-direct.unstable.wasm   — imports wasi_unstable.path_open
;;
;; The two variants test:
;;   (preview1) baseline — wasi-w2/path-write-read fixture confirms this
;;              works. If preview1 here ALSO works, our shim is correct
;;              when invoked via the modern namespace.
;;   (unstable) the namespace used by binji-clang-compiled binaries. If
;;              this FAILS but preview1 succeeds, our wasi_unstable
;;              namespace routing is broken. If this also SUCCEEDS, our
;;              runtime is fine — the bug is in binji's bundled libc.a.
;;
;; Layout (memory offsets):
;;   0x00     : path "greet.txt" (9 bytes, no NUL needed — path_open takes len)
;;   0x10     : fd_out scratch (4 bytes for i32)
;;   0x20     : output buffer "errno=NN\n" (write up to 12 bytes)
;;   0x40     : iovec (buf_ptr=0x20, buf_len=N) — 8 bytes
;;   0x100    : reserved for fd_write nwritten scratch (4 bytes)
;;
;; oflags (preview1 spec):
;;   __WASI_OFLAGS_CREAT = 1, __WASI_OFLAGS_TRUNC = 8 → O_CREAT|O_TRUNC = 9
;;
;; Returns from path_open are written as decimal ASCII so we don't need
;; to dispatch on specific errno values from the host side — the probe
;; runner just greps for "errno=" + literal.

(module
  ;; The MODULE-NAME placeholder will be substituted per variant in the
  ;; driver (search-and-replace "MODNAME" → "wasi_unstable" or
  ;; "wasi_snapshot_preview1" before assembling).
  (import "MODNAME" "path_open"
    (func $path_open
      (param i32  ;; dirfd
             i32  ;; dirflags (lookupflags)
             i32  ;; path_ptr
             i32  ;; path_len
             i32  ;; oflags
             i64  ;; fs_rights_base
             i64  ;; fs_rights_inheriting
             i32  ;; fdflags
             i32) ;; fd_out_ptr
      (result i32)))  ;; errno

  (import "MODNAME" "fd_write"
    (func $fd_write
      (param i32  ;; fd
             i32  ;; iovs_ptr
             i32  ;; iovs_len
             i32) ;; nwritten_ptr
      (result i32)))

  (import "MODNAME" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  ;; "greet.txt" at offset 0 (9 bytes).
  (data (i32.const 0) "greet.txt")

  ;; Banner "errno=" at offset 0x20 (6 bytes).
  (data (i32.const 0x20) "errno=")

  ;; Newline at offset 0x30 (1 byte).
  (data (i32.const 0x30) "\0a")

  (func $write_decimal (param $val i32)
    ;; Writes the decimal representation of $val to memory at 0x26
    ;; through 0x2f (10 bytes max — fits i32 unsigned). Updates a
    ;; running pointer in global $write_end.
    ;;
    ;; Strategy: write digits in reverse to a scratch area at 0x40
    ;; (avoiding collision with iovec which we'll set later), then
    ;; copy back into 0x26.. in correct order.
    (local $pos i32)
    (local $start i32)
    (local $digit i32)
    (local $tmp_end i32)
    (local.set $pos (i32.const 0x80))  ;; scratch end
    (local.set $tmp_end (local.get $pos))

    ;; Handle 0 specially.
    (if (i32.eqz (local.get $val))
      (then
        (i32.store8 offset=0x26 (i32.const 0) (i32.const 0x30))  ;; '0'
        (global.set $write_end (i32.const 0x27))
        (return)))

    ;; Convert digits in reverse order.
    (block $done
      (loop $digits
        (br_if $done (i32.eqz (local.get $val)))
        (local.set $digit (i32.rem_u (local.get $val) (i32.const 10)))
        (local.set $val   (i32.div_u (local.get $val) (i32.const 10)))
        (local.set $pos   (i32.sub (local.get $pos) (i32.const 1)))
        (i32.store8 (local.get $pos)
                    (i32.add (local.get $digit) (i32.const 0x30)))
        (br $digits)))

    ;; Now copy [pos, tmp_end) into [0x26, ...).
    (local.set $start (i32.const 0x26))
    (block $copy_done
      (loop $copy
        (br_if $copy_done (i32.ge_u (local.get $pos) (local.get $tmp_end)))
        (i32.store8 (local.get $start)
                    (i32.load8_u (local.get $pos)))
        (local.set $pos   (i32.add (local.get $pos)   (i32.const 1)))
        (local.set $start (i32.add (local.get $start) (i32.const 1)))
        (br $copy)))

    (global.set $write_end (local.get $start)))

  (global $write_end (mut i32) (i32.const 0x26))

  (func $_start (export "_start")
    (local $rc i32)
    (local $out_len i32)

    ;; Call path_open(fd=3, dirflags=0, path="greet.txt"@0, path_len=9,
    ;;                oflags=9 (O_CREAT|O_TRUNC), rights=ALL,
    ;;                rights_inheriting=ALL, fdflags=0, fd_out=0x10)
    (local.set $rc
      (call $path_open
        (i32.const 3)         ;; dirfd: the session-root preopen
        (i32.const 0)         ;; dirflags
        (i32.const 0)         ;; path_ptr → "greet.txt"
        (i32.const 9)         ;; path_len
        (i32.const 9)         ;; oflags = O_CREAT(1) | O_TRUNC(8) = 9
        (i64.const -1)        ;; rights_base = 0xFFFFFFFFFFFFFFFF
        (i64.const -1)        ;; rights_inheriting = 0xFFFFFFFFFFFFFFFF
        (i32.const 0)         ;; fdflags
        (i32.const 0x10)))    ;; fd_out scratch

    ;; Reset write_end (in case _start ever re-runs; defensive).
    (global.set $write_end (i32.const 0x26))

    ;; Convert errno to ASCII and place after "errno=" at 0x26.
    (call $write_decimal (local.get $rc))

    ;; Append newline at write_end.
    (i32.store8 (global.get $write_end) (i32.const 0x0a))
    (global.set $write_end
      (i32.add (global.get $write_end) (i32.const 1)))

    ;; Build iovec at 0x40 — { buf=0x20, len=write_end-0x20 }.
    (i32.store offset=0x40 (i32.const 0) (i32.const 0x20))
    (i32.store offset=0x44 (i32.const 0)
      (i32.sub (global.get $write_end) (i32.const 0x20)))

    ;; fd_write(stdout=1, iovs=0x40, iovs_len=1, nwritten=0x100)
    (drop (call $fd_write
      (i32.const 1)      ;; fd
      (i32.const 0x40)   ;; iovs
      (i32.const 1)      ;; iovs_len
      (i32.const 0x100)))

    ;; proc_exit(0)
    (call $proc_exit (i32.const 0)))
)
