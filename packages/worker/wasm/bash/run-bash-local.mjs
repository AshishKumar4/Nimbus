// Run asyncified GNU bash in local node V8 with a minimal WASI preview1 shim +
// the proven asyncify-native setjmp/longjmp + nimbus_proc process driver. This
// is the local acid test: real bash executing over the Nimbus fork/exec/pipe/
// setjmp layer, before the worker integration. `bash -c '<script>'`.
import { readFileSync } from 'node:fs';
const WASM = process.argv[2] || '/tmp/claude-1000/-home-mrwhite0racle-Nimbus/0b47f917-3635-4376-b32a-9347497a44f5/scratchpad/bashwork/bash.async.wasm';
const SCRIPT = process.argv[3] ?? 'echo hi';
const bytes = readFileSync(WASM);
const mod = new WebAssembly.Module(bytes);
const PAGE = 65536;
const te = new TextEncoder(), td = new TextDecoder();
let out = '';

const argv = ['bash', '-c', SCRIPT];
const environ = ['PATH=/bin:/usr/bin', 'HOME=/root', 'PS1=$ ', 'TERM=dumb'];

class Exit { constructor(code){ this.code = code; } }

// ---- driver state (asyncify + nimbus_proc), mirrors m4-sjlj.mjs ----
const ctx = { reason:null, rewinding:false, captureEnv:0, ljEnv:0, ljVal:0,
              scReason:null, resume:0, nextSlot:0 };
let inst;
// Views are fetched FRESH on every access — bash grows memory (malloc), which
// detaches any cached ArrayBuffer.
const DV = () => new DataView(inst.exports.memory.buffer);
const U8 = () => new Uint8Array(inst.exports.memory.buffer);

// asyncify buffers live near the top of a generously pre-grown memory, well
// above where bash's heap grows for a simple command.
let MAIN_BUF, SLOT0, SLOT_SIZE = 1<<20, MAIN_SIZE = 2<<20, NSLOT = 16;
function setupArena(){
  const arena = MAIN_SIZE + NSLOT*SLOT_SIZE;
  const headroom = 64<<20;                       // 64 MiB for bash's own heap
  const base = inst.exports.memory.buffer.byteLength;
  inst.exports.memory.grow(Math.ceil((arena+headroom)/PAGE));
  MAIN_BUF = base + headroom;                     // arena sits ABOVE the headroom
  SLOT0 = MAIN_BUF + MAIN_SIZE;
}
const slotAddr = (i) => SLOT0 + i*SLOT_SIZE;
function initHdr(addr, size){ const dv=DV(); dv.setUint32(addr, addr+8, true); dv.setUint32(addr+4, addr+size, true); }

// ---- minimal WASI preview1 ----
const ERRNO_BADF = 8, ERRNO_SUCCESS = 0, ERRNO_NOENT = 44, ERRNO_NOTCAPABLE = 76, ERRNO_SPIPE = 70;
function wstr(ptr, s){ const b = te.encode(s); U8().set(b, ptr); return b.length; }
const wasi = {
  args_sizes_get:(argcP, bufP)=>{ const dv=DV(); dv.setUint32(argcP, argv.length, true); dv.setUint32(bufP, argv.reduce((a,s)=>a+te.encode(s).length+1,0), true); return 0; },
  args_get:(ptrs, buf)=>{ const dv=DV(); let p=buf; for(const a of argv){ dv.setUint32(ptrs,p,true); ptrs+=4; p+=wstr(p,a); U8()[p++]=0; } return 0; },
  environ_sizes_get:(cP,bP)=>{ const dv=DV(); dv.setUint32(cP, environ.length, true); dv.setUint32(bP, environ.reduce((a,s)=>a+te.encode(s).length+1,0), true); return 0; },
  environ_get:(ptrs,buf)=>{ const dv=DV(); let p=buf; for(const e of environ){ dv.setUint32(ptrs,p,true); ptrs+=4; p+=wstr(p,e); U8()[p++]=0; } return 0; },
  clock_time_get:(id,prec,tP)=>{ DV().setBigUint64(tP, BigInt(Date.now())*1000000n, true); return 0; },
  random_get:(buf,len)=>{ const u8=U8(); for(let i=0;i<len;i++) u8[buf+i]=(Math.random()*256)|0; return 0; },
  fd_fdstat_get:(fd,stP)=>{ const dv=DV(); dv.setUint8(stP, fd<=2?2:4); dv.setUint16(stP+2,0,true); dv.setBigUint64(stP+8,0xffffffffffffffffn,true); dv.setBigUint64(stP+16,0xffffffffffffffffn,true); return 0; },
  fd_fdstat_set_flags:()=>0,
  fd_prestat_get:(fd,p)=>ERRNO_BADF,           // no preopens
  fd_prestat_dir_name:()=>ERRNO_BADF,
  fd_filestat_get:(fd,p)=>{ U8().fill(0,p,p+64); return 0; },
  path_filestat_get:()=>ERRNO_NOENT,
  fd_read:(fd,iovs,n,nread)=>{ DV().setUint32(nread,0,true); return 0; },   // stdin EOF
  fd_write:(fd,iovs,n,nwritten)=>{ const dv=DV(),u8=U8(); let w=0,s=''; for(let i=0;i<n;i++){ const p=dv.getUint32(iovs+i*8,true),l=dv.getUint32(iovs+i*8+4,true); s+=td.decode(u8.subarray(p,p+l)); w+=l; } if(fd===1) out+=s; else if(fd===2) process.stderr.write('[bash stderr] '+s); dv.setUint32(nwritten,w,true); return 0; },
  fd_seek:(fd,off,wh,newoff)=>{ DV().setBigUint64(newoff,0n,true); return ERRNO_SPIPE; },
  fd_tell:(fd,p)=>{ DV().setBigUint64(p,0n,true); return 0; },
  fd_close:()=>0,
  fd_readdir:()=>ERRNO_BADF,
  path_open:(a,b,c,d,e,f,g,h,fdP)=>ERRNO_NOENT,
  path_readlink:()=>ERRNO_NOENT,
  path_rename:()=>ERRNO_NOENT,
  path_unlink_file:()=>ERRNO_NOENT,
  poll_oneoff:(inp,outp,n,nev)=>{ DV().setUint32(nev,0,true); return 0; },
  proc_exit:(code)=>{ throw new Exit(code); },
};
// log any unimplemented preview1 call instead of trapping obscurely
const CALLS=[];
function trace(ns,obj){ return new Proxy(obj,{get:(t,k)=>{ const f = k in t ? t[k] : ((...a)=>{ process.stderr.write(`[wasi missing] ${String(k)}\n`); return 0; }); return (...a)=>{ CALLS.push(ns+'.'+String(k)); if(CALLS.length>40)CALLS.shift(); return f(...a); }; }}); }
const wasiProxy = trace('wasi', wasi);

// ---- nimbus_proc process ABI ----
function npUnwind(reason, setup, buf){ if(ctx.rewinding){ inst.exports.asyncify_stop_rewind(); ctx.rewinding=false; return ctx.resume; } ctx.reason=reason; setup&&setup(); initHdr(buf, buf===MAIN_BUF?MAIN_SIZE:SLOT_SIZE); inst.exports.asyncify_start_unwind(buf); return 0; }
const nimbus_proc = {
  setjmp:(env)=>{ if(ctx.rewinding){ inst.exports.asyncify_stop_rewind(); ctx.rewinding=false; return; }
    ctx.reason='capture'; ctx.captureEnv=env; const idx=ctx.nextSlot++; if(idx>=NSLOT) throw new Error('out of setjmp slots');
    const dv=DV(); dv.setInt32(env,idx,true); dv.setInt32(env+4,0,true); initHdr(slotAddr(idx),SLOT_SIZE); inst.exports.asyncify_start_unwind(slotAddr(idx)); },
  longjmp:(env,val)=>{ if(ctx.rewinding){ inst.exports.asyncify_stop_rewind(); ctx.rewinding=false; return; }
    ctx.reason='longjmp'; ctx.ljEnv=env; ctx.ljVal=val; initHdr(MAIN_BUF,MAIN_SIZE); inst.exports.asyncify_start_unwind(MAIN_BUF); },
  fork:()=>{ throw new Error('fork() called — needs the multi-instance driver (not wired in this smoke)'); },
  vfork:()=>{ throw new Error('vfork'); },
  execve:()=>{ throw new Error('execve'); },
  waitpid:()=>{ throw new Error('waitpid'); },
  pipe:()=>-1, dup:(f)=>f, dup2:(o,n)=>n, kill:()=>0, setpgid:()=>0, getpgid:()=>1, getppid:()=>0,
  tcsetpgrp:()=>0, tcgetpgrp:()=>1, tcgetattr:()=>-1, tcsetattr:()=>0,
};
const env = { getpid:()=>1, getuid:()=>0, geteuid:()=>0, getgid:()=>0, getegid:()=>0,
  setuid:()=>0, setgid:()=>0, umask:()=>0o22, gethostname:(p,l)=>{ U8().set(te.encode('nimbus'),p); return 0; },
  dlopen:()=>0, dlsym:()=>0, dlclose:()=>0, dlerror:()=>0 };

inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasiProxy, nimbus_proc: trace('np',nimbus_proc), env: trace('env',env) });
setupArena();

// ---- drive _start through asyncify (capture/longjmp), mirrors m4-sjlj.mjs ----
let exitCode = null, steps = 0;
try {
  for(;;){
    if(++steps > 200000) throw new Error('driver runaway');
    inst.exports._start();
    if(ctx.reason===null) break;             // _start returned normally (exit 0)
    inst.exports.asyncify_stop_unwind();
    const r = ctx.reason; ctx.reason=null;
    if(r==='capture'){ const dv=DV(); const idx=dv.getInt32(ctx.captureEnv,true); dv.setUint32(ctx.captureEnv+8, dv.getUint32(slotAddr(idx),true), true); ctx.rewinding=true; inst.exports.asyncify_start_rewind(slotAddr(idx)); }
    else if(r==='longjmp'){ const dv=DV(); const idx=dv.getInt32(ctx.ljEnv,true), hw=dv.getUint32(ctx.ljEnv+8,true); dv.setInt32(ctx.ljEnv+4, ctx.ljVal, true); dv.setUint32(slotAddr(idx), hw, true); ctx.rewinding=true; inst.exports.asyncify_start_rewind(slotAddr(idx)); }
    else throw new Error('unexpected reason '+r);
  }
} catch(e){ if(e instanceof Exit) exitCode=e.code; else { process.stderr.write('DRIVER ERROR: '+(e.stack||e)+'\nLAST CALLS: '+CALLS.slice(-20).join(' ')+'\n'); exitCode=-1; } }

process.stdout.write('=== bash stdout ===\n'+out);
process.stdout.write(`=== exit code: ${exitCode} · setjmp slots used: ${ctx.nextSlot} · driver steps: ${steps} ===\n`);
process.exit(exitCode===0?0:1);
