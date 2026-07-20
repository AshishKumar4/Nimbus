// Local (node, same V8) proof of asyncify-native setjmp/longjmp + its
// interaction with asyncify fork and blocking syscalls. Mirrors the M1/M2
// facet scheduler; the setjmp "capture" = unwind into a per-jmp_buf slot then
// immediately rewind it (so setjmp returns 0 and the slot retains a replayable
// snapshot); longjmp = unwind current stack, restore the slot cursor, rewind.
import { readFileSync } from 'node:fs';
const mod = new WebAssembly.Module(readFileSync('/tmp/claude-1000/-home-mrwhite0racle-Nimbus/0b47f917-3635-4376-b32a-9347497a44f5/scratchpad/bashwork/m4-sjlj.wasm'));
const PAGE = 65536;
const outs = [];

// jmp_buf layout in linear memory: [env+0]=slot, [env+4]=retval, [env+8]=hw.
function makeProc() {
  const ctx = { reason: null, rewinding: false, nextSlot: 0,
                captureEnv: 0, ljEnv: 0, ljVal: 0, scArg: 0, resumeMain: 0, forkResume: 0 };
  const inst = new WebAssembly.Instance(mod, { env: {
    fork: () => sysUnwind(ctx, 'fork', () => ctx.forkResume),
    syscall: (a) => { if (!ctx.rewinding) ctx.scArg = a; return sysUnwind(ctx, 'syscall', () => ctx.resumeMain); },
    emit: (tag, val) => outs.push({ pid: ctx.pid, tag, val }),
  }, nimbus_proc: {
    setjmp: (env) => { if (ctx.rewinding) { ctx.inst.exports.asyncify_stop_rewind(); ctx.rewinding = false; return; }
      ctx.reason = 'capture'; ctx.captureEnv = env;
      const dv = new DataView(mem(ctx));
      const idx = ctx.nextSlot++;
      dv.setInt32(env + 0, idx, true); dv.setInt32(env + 4, 0, true);   // slot, retval=0
      initHdr(ctx, slotAddr(ctx, idx), ctx.inst.exports.jslot_size());
      ctx.inst.exports.asyncify_start_unwind(slotAddr(ctx, idx)); },
    longjmp: (env, val) => { if (ctx.rewinding) { ctx.inst.exports.asyncify_stop_rewind(); ctx.rewinding = false; return; }
      ctx.reason = 'longjmp'; ctx.ljEnv = env; ctx.ljVal = val;
      initHdr(ctx, ctx.inst.exports.asyncify_buffer_ptr(), ctx.inst.exports.asyncify_buffer_size());
      ctx.inst.exports.asyncify_start_unwind(ctx.inst.exports.asyncify_buffer_ptr()); },
  } });
  ctx.inst = inst;
  return ctx;
}
function mem(ctx) { return ctx.inst.exports.memory.buffer; }
function slotAddr(ctx, idx) { return ctx.inst.exports.jslot_ptr(idx); }
function initHdr(ctx, addr, size) { const v = new DataView(mem(ctx)); v.setUint32(addr, addr + 8, true); v.setUint32(addr + 4, addr + size, true); }
function sysUnwind(ctx, reason, resumeFn) {
  if (ctx.rewinding) { ctx.inst.exports.asyncify_stop_rewind(); ctx.rewinding = false; return resumeFn(); }
  ctx.reason = reason;
  initHdr(ctx, ctx.inst.exports.asyncify_buffer_ptr(), ctx.inst.exports.asyncify_buffer_size());
  ctx.inst.exports.asyncify_start_unwind(ctx.inst.exports.asyncify_buffer_ptr());
  return 0;
}

let pidSeq = 100;
function drive(ctx, mode, seed) {
  ctx.pid = ctx.pid ?? pidSeq++;
  const ex = ctx.inst.exports;
  for (let guard = 0; ; guard++) {
    if (guard > 100000) throw new Error('runaway');
    const ret = ex.run(mode, seed);
    if (ctx.reason === null) return ret;      // normal completion
    ex.asyncify_stop_unwind();
    const r = ctx.reason; ctx.reason = null;
    if (r === 'capture') {
      const dv = new DataView(mem(ctx));
      const idx = dv.getInt32(ctx.captureEnv + 0, true);
      dv.setUint32(ctx.captureEnv + 8, dv.getUint32(slotAddr(ctx, idx), true), true);  // hw into jmp_buf
      ctx.rewinding = true; ex.asyncify_start_rewind(slotAddr(ctx, idx));
    } else if (r === 'longjmp') {
      const dv = new DataView(mem(ctx));
      const idx = dv.getInt32(ctx.ljEnv + 0, true);
      const hw = dv.getUint32(ctx.ljEnv + 8, true);
      dv.setInt32(ctx.ljEnv + 4, ctx.ljVal, true);          // inject retval
      dv.setUint32(slotAddr(ctx, idx), hw, true);           // restore snapshot cursor
      ctx.rewinding = true; ex.asyncify_start_rewind(slotAddr(ctx, idx));
    } else if (r === 'syscall') {
      ctx.resumeMain = ctx.scArg * 2;
      ctx.rewinding = true; ex.asyncify_start_rewind(ex.asyncify_buffer_ptr());
    } else if (r === 'fork') {
      // Snapshot lives in main_buf. Create child, copy full memory, drive it
      // (returns 0), then resume parent with the child pid.
      const child = makeProc();
      const need = mem(ctx).byteLength;
      child.inst.exports.memory.grow((need - child.inst.exports.memory.buffer.byteLength) / PAGE);
      new Uint8Array(child.inst.exports.memory.buffer).set(new Uint8Array(mem(ctx)));
      // restore child's exported globals (__stack_pointer etc.)
      for (const [k, v] of Object.entries(ex)) if (v instanceof WebAssembly.Global) child.inst.exports[k].value = v.value;
      const childPid = pidSeq++; child.pid = childPid; child.nextSlot = ctx.nextSlot;
      child.rewinding = true; child.inst.exports.asyncify_start_rewind(child.inst.exports.asyncify_buffer_ptr());
      child.forkResume = 0;
      const childRet = drive(child, mode, seed);
      outs.push({ pid: ctx.pid, tag: 200, val: childRet });   // child final return
      ctx.forkResume = childPid;
      ctx.rewinding = true; ex.asyncify_start_rewind(ex.asyncify_buffer_ptr());
    }
  }
}

function tags(pid, t) { return outs.filter((o) => o.pid === pid && o.tag === t).map((o) => o.val); }
let ok = true;
function check(name, cond, extra = '') { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); ok = ok && cond; }

// --- mode 1: basic setjmp/longjmp across deep recursion ---
{ outs.length = 0; const p = makeProc(); const ret = drive(p, 1, 7);
  const rc = tags(p.pid, 10);           // [0, 7]
  console.log('mode1 setjmp returns:', rc, 'final:', ret, 'preserved(keep):', tags(p.pid, 11), 'frames:', tags(p.pid, 12), 'unreachable99:', tags(p.pid, 99));
  check('setjmp returns 0 then longjmp value', JSON.stringify(rc) === JSON.stringify([0, 7]));
  check('final return == longjmp value', ret === 7);
  check('local set before setjmp preserved (555 both landings)', JSON.stringify(tags(p.pid, 11)) === JSON.stringify([555, 555]));
  check('frame address identical across landings', tags(p.pid, 12).length === 2 && tags(p.pid, 12)[0] === tags(p.pid, 12)[1]);
  check('code after longjmp did NOT run', tags(p.pid, 99).length === 0);
}
// --- mode 2: setjmp interacts with a real asyncify fork; child longjmps ---
{ outs.length = 0; const p = makeProc(); const ret = drive(p, 2, 0);
  const parentPid = p.pid;
  console.log('mode2 parent rc:', tags(parentPid, 10), 'parent saw child pid(tag20):', tags(parentPid, 20), 'child final(tag200):', tags(parentPid, 200), 'parent ret:', ret);
  check('parent setjmp path stays rc=0', tags(parentPid, 10).includes(0));
  check('child longjmp made its setjmp return 77', tags(parentPid, 200)[0] === 77);
  check('parent returns 0 (its own setjmp not disturbed by child)', ret === 0);
}
// --- mode 3: blocking syscall (main buf) between setjmp and longjmp ---
{ outs.length = 0; const p = makeProc(); const ret = drive(p, 3, 9);
  console.log('mode3 rc:', tags(p.pid, 10), 'syscall ret(tag30):', tags(p.pid, 30), 'final:', ret);
  check('setjmp 0 then longjmp value after a blocking syscall', JSON.stringify(tags(p.pid, 10)) === JSON.stringify([0, 19]));
  check('syscall returned seed*2 = 18', tags(p.pid, 30)[0] === 18);
  check('final == syscall_ret+1 = 19 (jmp slot survived the main-buf unwind)', ret === 19);
}
console.log(ok ? '\nALL SETJMP-ASYNCIFY LOCAL PASS' : '\nLOCAL FAIL');
process.exit(ok ? 0 : 1);
