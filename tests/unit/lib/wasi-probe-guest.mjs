/**
 * A tiny WASI preview1 guest, compiled from WAT at test time, that exercises
 * syscall behaviour no BusyBox applet can express.
 *
 * The bash runner turns every `cu_<name>.wasm` key of `__NIMBUS_WASM` into an
 * executable at /bin/<name> (see newSession in bash-runner.ts), so staging this
 * module as `cu_probe.wasm` makes `probe` a real command inside the shell. The
 * guest dispatches on argv[1], so one staged module serves every probe:
 *
 *   probe readv       one fd_read over three non-adjacent 2-byte iovecs
 *                     -> `nread=<n> iov0=<xx> iov1=<xx> iov2=<xx>`
 *   probe badwrite    fd_write to fd 42, which was never opened
 *                     -> `errno=<n> nwritten=<n>` (payload `LEAKED-TO-STDOUT`)
 *   probe clockid     clock_time_get for ids 0, 1 and 99
 *                     -> `rt=<errno>:<nonzero> mono=<errno>:<nonzero> bad=<errno>:<nonzero>`
 *   probe clocktwice  two REALTIME readings with a bounded spin between them
 *                     -> `advanced=<0|1>`
 *
 * Untouched read buffers read back as `..`, so a host that fills only the first
 * iovec is visible in the output rather than merely implied by nread.
 *
 * Directory note: lives under tests/unit/lib/ because the suite runs
 * `tests/unit/*.mjs`, which would otherwise execute a helper as a test.
 */
import wabtInit from 'wabt';

// Memory map. Fixed addresses keep the WAT free of pointer arithmetic.
//   0x0010 argc          0x0014 argv byte size    0x0020 argv pointers
//   0x0080 argv bytes    0x0180 flush iovec       0x0190 flush nwritten
//   0x01A0 badwrite iovec 0x01B0 badwrite nwritten
//   0x01C0 read iovecs (3) 0x01E0 nread
//   0x0200/0x0208/0x0210 clock results   0x0220 decimal scratch (ends 0x022C)
//   0x0800/0x0900/0x0A00 read buffers (deliberately non-adjacent)
//   0x1000 output buffer  0x1800+ string literals
const WAT = `(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "clock_time_get" (func $clock_time_get (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)
  (global $outp (mut i32) (i32.const 0x1000))

  (data (i32.const 0x1800) "readv\\00")
  (data (i32.const 0x1820) "badwrite\\00")
  (data (i32.const 0x1840) "clockid\\00")
  (data (i32.const 0x1860) "clocktwice\\00")
  (data (i32.const 0x1880) "LEAKED-TO-STDOUT")
  (data (i32.const 0x18a0) "nread=\\00")
  (data (i32.const 0x18c0) " iov0=\\00")
  (data (i32.const 0x18e0) " iov1=\\00")
  (data (i32.const 0x1900) " iov2=\\00")
  (data (i32.const 0x1920) "errno=\\00")
  (data (i32.const 0x1940) " nwritten=\\00")
  (data (i32.const 0x1960) "rt=\\00")
  (data (i32.const 0x1980) " mono=\\00")
  (data (i32.const 0x19a0) " bad=\\00")
  (data (i32.const 0x19c0) "advanced=\\00")
  (data (i32.const 0x19e0) "PROBE-BAD-MODE\\00")
  (data (i32.const 0x1a00) "PROBE-NO-MODE\\00")
  (data (i32.const 0x1a20) "PROBE-READ-ERR errno=\\00")

  ;; Append one byte to the output buffer.
  (func $put (param $b i32)
    (i32.store8 (global.get $outp) (local.get $b))
    (global.set $outp (i32.add (global.get $outp) (i32.const 1))))

  ;; Append a NUL-terminated literal.
  (func $puts (param $p i32) (local $c i32)
    (block $done (loop $l
      (local.set $c (i32.load8_u (local.get $p)))
      (br_if $done (i32.eqz (local.get $c)))
      (call $put (local.get $c))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $l))))

  ;; Append an unsigned decimal. Digits are produced least-significant first
  ;; into the scratch area, then replayed forward.
  (func $putu (param $v i32) (local $p i32)
    (if (i32.eqz (local.get $v)) (then (call $put (i32.const 48)) (return)))
    (local.set $p (i32.const 0x22c))
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $v)))
      (local.set $p (i32.sub (local.get $p) (i32.const 1)))
      (i32.store8 (local.get $p) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10))))
      (local.set $v (i32.div_u (local.get $v) (i32.const 10)))
      (br $l)))
    (block $done2 (loop $l2
      (br_if $done2 (i32.ge_u (local.get $p) (i32.const 0x22c)))
      (call $put (i32.load8_u (local.get $p)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $l2))))

  ;; Emit the accumulated output on fd 1 and reset the buffer.
  (func $flush
    (i32.store (i32.const 0x180) (i32.const 0x1000))
    (i32.store (i32.const 0x184) (i32.sub (global.get $outp) (i32.const 0x1000)))
    (drop (call $fd_write (i32.const 1) (i32.const 0x180) (i32.const 1) (i32.const 0x190)))
    (global.set $outp (i32.const 0x1000)))

  (func $done (param $code i32)
    (call $put (i32.const 10))
    (call $flush)
    (call $proc_exit (local.get $code)))

  (func $streq (param $a i32) (param $b i32) (result i32) (local $x i32) (local $y i32)
    (loop $l
      (local.set $x (i32.load8_u (local.get $a)))
      (local.set $y (i32.load8_u (local.get $b)))
      (if (i32.ne (local.get $x) (local.get $y)) (then (return (i32.const 0))))
      (if (i32.eqz (local.get $x)) (then (return (i32.const 1))))
      (local.set $a (i32.add (local.get $a) (i32.const 1)))
      (local.set $b (i32.add (local.get $b) (i32.const 1)))
      (br $l))
    (i32.const 0))

  ;; One fd_read across three 2-byte iovecs whose buffers are 256 bytes apart,
  ;; so a host that treats the vector as one contiguous span is caught too.
  (func $p_readv (local $e i32)
    (i32.store16 (i32.const 0x800) (i32.const 0x2e2e))
    (i32.store16 (i32.const 0x900) (i32.const 0x2e2e))
    (i32.store16 (i32.const 0xa00) (i32.const 0x2e2e))
    (i32.store (i32.const 0x1c0) (i32.const 0x800)) (i32.store (i32.const 0x1c4) (i32.const 2))
    (i32.store (i32.const 0x1c8) (i32.const 0x900)) (i32.store (i32.const 0x1cc) (i32.const 2))
    (i32.store (i32.const 0x1d0) (i32.const 0xa00)) (i32.store (i32.const 0x1d4) (i32.const 2))
    (i32.store (i32.const 0x1e0) (i32.const 0))
    (local.set $e (call $fd_read (i32.const 0) (i32.const 0x1c0) (i32.const 3) (i32.const 0x1e0)))
    (if (local.get $e) (then
      (call $puts (i32.const 0x1a20)) (call $putu (local.get $e)) (call $done (i32.const 1))))
    (call $puts (i32.const 0x18a0)) (call $putu (i32.load (i32.const 0x1e0)))
    (call $puts (i32.const 0x18c0))
    (call $put (i32.load8_u (i32.const 0x800))) (call $put (i32.load8_u (i32.const 0x801)))
    (call $puts (i32.const 0x18e0))
    (call $put (i32.load8_u (i32.const 0x900))) (call $put (i32.load8_u (i32.const 0x901)))
    (call $puts (i32.const 0x1900))
    (call $put (i32.load8_u (i32.const 0xa00))) (call $put (i32.load8_u (i32.const 0xa01)))
    (call $done (i32.const 0)))

  ;; fd 42 was never opened. A conforming host answers EBADF (8) and writes
  ;; nothing; a host that funnels unknown fds to stdout leaks the marker.
  (func $p_badwrite (local $e i32)
    (i32.store (i32.const 0x1a0) (i32.const 0x1880))
    (i32.store (i32.const 0x1a4) (i32.const 16))
    (i32.store (i32.const 0x1b0) (i32.const 0))
    (local.set $e (call $fd_write (i32.const 42) (i32.const 0x1a0) (i32.const 1) (i32.const 0x1b0)))
    (call $puts (i32.const 0x1920)) (call $putu (local.get $e))
    (call $puts (i32.const 0x1940)) (call $putu (i32.load (i32.const 0x1b0)))
    (call $done (i32.const 0)))

  (func $p_clockid (local $e0 i32) (local $e1 i32) (local $e2 i32)
    (i64.store (i32.const 0x200) (i64.const 0))
    (i64.store (i32.const 0x208) (i64.const 0))
    (i64.store (i32.const 0x210) (i64.const 0))
    (local.set $e0 (call $clock_time_get (i32.const 0) (i64.const 1000) (i32.const 0x200)))
    (local.set $e1 (call $clock_time_get (i32.const 1) (i64.const 1000) (i32.const 0x208)))
    (local.set $e2 (call $clock_time_get (i32.const 99) (i64.const 1000) (i32.const 0x210)))
    (call $puts (i32.const 0x1960)) (call $putu (local.get $e0)) (call $put (i32.const 58))
    (call $putu (i64.ne (i64.load (i32.const 0x200)) (i64.const 0)))
    (call $puts (i32.const 0x1980)) (call $putu (local.get $e1)) (call $put (i32.const 58))
    (call $putu (i64.ne (i64.load (i32.const 0x208)) (i64.const 0)))
    (call $puts (i32.const 0x19a0)) (call $putu (local.get $e2)) (call $put (i32.const 58))
    (call $putu (i64.ne (i64.load (i32.const 0x210)) (i64.const 0)))
    (call $done (i32.const 0)))

  ;; Spin until REALTIME moves, capped so a frozen clock still terminates.
  (func $p_clocktwice (local $i i32)
    (i64.store (i32.const 0x200) (i64.const 0))
    (i64.store (i32.const 0x208) (i64.const 0))
    (drop (call $clock_time_get (i32.const 0) (i64.const 1000) (i32.const 0x200)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 1000000)))
      (drop (call $clock_time_get (i32.const 0) (i64.const 1000) (i32.const 0x208)))
      (br_if $done (i64.gt_u (i64.load (i32.const 0x208)) (i64.load (i32.const 0x200))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $puts (i32.const 0x19c0))
    (call $putu (i64.gt_u (i64.load (i32.const 0x208)) (i64.load (i32.const 0x200))))
    (call $done (i32.const 0)))

  (func (export "_start") (local $mode i32)
    (drop (call $args_sizes_get (i32.const 0x10) (i32.const 0x14)))
    (if (i32.lt_u (i32.load (i32.const 0x10)) (i32.const 2)) (then
      (call $puts (i32.const 0x1a00)) (call $done (i32.const 2))))
    (drop (call $args_get (i32.const 0x20) (i32.const 0x80)))
    (local.set $mode (i32.load (i32.const 0x24)))
    (if (call $streq (local.get $mode) (i32.const 0x1800)) (then (call $p_readv) (return)))
    (if (call $streq (local.get $mode) (i32.const 0x1820)) (then (call $p_badwrite) (return)))
    (if (call $streq (local.get $mode) (i32.const 0x1840)) (then (call $p_clockid) (return)))
    (if (call $streq (local.get $mode) (i32.const 0x1860)) (then (call $p_clocktwice) (return)))
    (call $puts (i32.const 0x19e0)) (call $done (i32.const 2)))
)`;

// wabt loads asynchronously; awaiting it at module scope keeps every consumer
// of this helper synchronous.
const wabt = await wabtInit();

let cached = null;

/** Compile the probe guest once per process. */
export function probeModule() {
  if (cached) return cached;
  const parsed = wabt.parseWat('probe.wat', WAT, {});
  try {
    parsed.validate();
    cached = new WebAssembly.Module(parsed.toBinary({}).buffer);
  } finally {
    parsed.destroy();
  }
  return cached;
}

/** The `__NIMBUS_WASM` entry that makes the guest runnable as `probe`. */
export function probeWasmEntry() {
  return { 'cu_probe.wasm': probeModule() };
}
