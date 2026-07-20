/* M0-style probe: asyncify-native setjmp/longjmp, proving it composes with
 * asyncify's fork/blocking unwind — WITHOUT any wasm-EH in the module (so
 * wasm-opt --asyncify instruments it cleanly). setjmp/longjmp trap to the
 * nimbus_proc.{setjmp,longjmp} host imports; the host drives the capture
 * (unwind-into-a-slot then immediate rewind) and the longjmp (unwind current
 * stack, rewind the saved slot). retval travels in the jmp_buf (linear memory),
 * not via asyncify's saved operand, so longjmp can inject any value.
 *
 * emit tags: 10 setjmp return value · 11 preserved local before setjmp ·
 * 12 frame addr · 20 fork child pid seen by parent · 21 child marker ·
 * 30 syscall return · 40 deep-recursion accumulator · 99 unreachable-after-longjmp */

__attribute__((import_module("nimbus_proc"), import_name("setjmp")))
extern void np_setjmp(void *env);
__attribute__((import_module("nimbus_proc"), import_name("longjmp")))
extern void np_longjmp(void *env, int val);
__attribute__((import_module("env"), import_name("fork")))
extern int sys_fork(void);
__attribute__((import_module("env"), import_name("syscall")))
extern int sys_syscall(int a);
__attribute__((import_module("env"), import_name("emit")))
extern void emit(int tag, int val);

/* jmp_buf lives entirely in linear memory so it survives fork's memory copy:
 * slot = the capture buffer index, retval = host-injected setjmp result,
 * hw = the asyncify high-water cursor to replay on longjmp. No host-side map,
 * so a forked child can longjmp using its own copied jmp_buf. */
typedef struct { int slot; volatile int retval; int hw; } njb[1];

/* main asyncify buffer (fork / blocking syscalls) */
static unsigned char main_buf[32768];
__attribute__((export_name("asyncify_buffer_ptr"))) unsigned char *asyncify_buffer_ptr(void) { return main_buf; }
__attribute__((export_name("asyncify_buffer_size"))) int asyncify_buffer_size(void) { return sizeof(main_buf); }

/* per-setjmp capture slots (each holds a full stack unwind) */
#define NSLOT 8
static unsigned char jslots[NSLOT][65536];
__attribute__((export_name("jslot_ptr"))) unsigned char *jslot_ptr(int i) { return jslots[i]; }
__attribute__((export_name("jslot_size"))) int jslot_size(void) { return 65536; }

__attribute__((returns_twice, noinline))
static int nimbus_setjmp(njb e) {
  np_setjmp((void *)e);   /* host: capture (unwind+rewind); also the longjmp landing */
  return e->retval;       /* 0 first time, injected val on longjmp */
}
__attribute__((noinline))
static void nimbus_longjmp(njb e, int val) {
  np_longjmp((void *)e, val ? val : 1);
  __builtin_unreachable();
}

/* deep recursion so capture/longjmp cross many frames */
__attribute__((noinline))
static int go_deep(njb e, int depth, int target) {
  volatile int local = 1000 + depth;
  if (depth > 0) {
    int r = go_deep(e, depth - 1, target);
    return r + (local & 1);
  }
  emit(40, target);
  nimbus_longjmp(e, target);   /* jump all the way back to setjmp */
  return local;                /* unreachable */
}

__attribute__((export_name("run")))
int run(int mode, int seed) {
  if (mode == 1) {
    /* basic: setjmp -> 0 -> deep -> longjmp(seed) -> setjmp returns seed */
    volatile int keep = 555;            /* set BEFORE setjmp; must survive */
    njb e;
    int rc = nimbus_setjmp(e);
    emit(12, (int)(unsigned long)&e);
    emit(10, rc);
    emit(11, keep);
    if (rc == 0) {
      go_deep(e, 12, seed);
      emit(99, -1);                     /* must NOT run */
    }
    return rc;                          /* seed */
  }
  if (mode == 2) {
    /* interaction with fork: setjmp, fork, child longjmps in its own image */
    njb e;
    int rc = nimbus_setjmp(e);
    emit(10, rc);
    if (rc == 0) {
      int pid = sys_fork();
      if (pid == 0) { emit(21, 0); nimbus_longjmp(e, 77); }  /* child jumps */
      emit(20, pid);
      return 0;                         /* parent: setjmp still 0 path */
    }
    return rc;                          /* child after longjmp: 77 */
  }
  if (mode == 3) {
    /* interaction with a blocking syscall between setjmp and longjmp: the main
     * asyncify buffer is used by the syscall; the jmp slot must be independent */
    njb e;
    int rc = nimbus_setjmp(e);
    emit(10, rc);
    if (rc == 0) {
      int s = sys_syscall(seed);        /* unwinds+rewinds via main_buf */
      emit(30, s);
      go_deep(e, 6, s + 1);             /* then longjmp */
      emit(99, -1);
    }
    return rc;                          /* s+1 */
  }
  return -1;
}
