// Local (node, same V8) driver for FORKING bash: multi-instance fork/vfork +
// a supervisor PipeTable + waitpid + per-process WASI fd table, over the proven
// asyncify-native setjmp/longjmp. Proves subshell ( ), $( ), and builtin
// pipelines — the acid-test control primitives — without external coreutils.
// Mirrors the fork M1/M2 scheduler + M3 pipe layer + the m4-sjlj setjmp driver.
import { readFileSync } from 'node:fs';
const WASM = process.argv[2];
const SCRIPT = process.argv[3] ?? 'echo hi';
const mod = new WebAssembly.Module(readFileSync(WASM));
const PAGE = 65536, te = new TextEncoder(), td = new TextDecoder();
const MAIN_SIZE = 8<<20, SLOT_SIZE = 1<<20, NSLOT = 32, HEADROOM = 96<<20;

const argv = ['bash', '-c', SCRIPT];
const environ = ['PATH=/bin:/usr/bin','HOME=/root','PS1=$ ','TERM=dumb'];
class Exit { constructor(c){ this.code=c; } }

// ---- supervisor state ----
let pidNext = 100, pipeNext = 1;
const procs = new Map();          // pid -> proc
const pipes = new Map();          // pipeId -> {chunks,queued,readers,writers,readW,writeW}
const runnable = [];              // procs ready to step
const exitStatus = new Map();     // pid -> status
const waiters = [];               // {proc, targetPid}
let rootExit = null;

function newPipe(){ const id=pipeNext++; pipes.set(id,{chunks:[],queued:0,readers:1,writers:1,readW:[],writeW:[]}); return id; }

// ---- per-process instance + imports ----
function makeProc(pid, ppid, fds){
  const proc = { pid, ppid, fds, inst:null,
    ctx:{ reason:null, rewinding:false, captureEnv:0, ljEnv:0, ljVal:0, nextSlot:0, resume:0 },
    MAIN_BUF:0, SLOT0:0, capture:null /* for $(): capture stdout to string */ };
  const DV=()=>new DataView(proc.inst.exports.memory.buffer);
  const U8=()=>new Uint8Array(proc.inst.exports.memory.buffer);
  proc.DV=DV; proc.U8=U8;
  const slotAddr=(i)=>proc.SLOT0+i*SLOT_SIZE;
  proc.slotAddr=slotAddr;
  const initHdr=(a,s)=>{const dv=DV();dv.setUint32(a,a+8,true);dv.setUint32(a+4,a+s,true);};
  proc.initHdr=initHdr;
  const wstr=(p,s)=>{const b=te.encode(s);U8().set(b,p);return b.length;};
  const c=proc.ctx;

  // fd write sink: pipe end -> ring; stdout -> out/capture; stderr -> stderr
  function writeFd(fd, bytes){
    const e = proc.fds.get(fd);
    if(e && e.kind==='pipe'){ const pp=pipes.get(e.pipeId); pp.chunks.push(bytes.slice()); pp.queued+=bytes.length; wakePipe(pp); return bytes.length; }
    const s = td.decode(bytes);
    if(e && e.kind==='stderr') process.stderr.write('[bash stderr] '+s);
    else if(proc.capture!==null) proc.capture.buf += s;
    else OUT.buf += s;
    return bytes.length;
  }

  const wasi = {
    args_sizes_get:(a,b)=>{const dv=DV();dv.setUint32(a,argv.length,true);dv.setUint32(b,argv.reduce((x,s)=>x+te.encode(s).length+1,0),true);return 0;},
    args_get:(ptrs,buf)=>{const dv=DV();let p=buf;for(const a of argv){dv.setUint32(ptrs,p,true);ptrs+=4;p+=wstr(p,a);U8()[p++]=0;}return 0;},
    environ_sizes_get:(a,b)=>{const dv=DV();dv.setUint32(a,environ.length,true);dv.setUint32(b,environ.reduce((x,s)=>x+te.encode(s).length+1,0),true);return 0;},
    environ_get:(ptrs,buf)=>{const dv=DV();let p=buf;for(const e of environ){dv.setUint32(ptrs,p,true);ptrs+=4;p+=wstr(p,e);U8()[p++]=0;}return 0;},
    clock_time_get:(id,pr,t)=>{DV().setBigUint64(t,BigInt(Date.now())*1000000n,true);return 0;},
    random_get:(b,l)=>{const u=U8();for(let i=0;i<l;i++)u[b+i]=(Math.random()*256)|0;return 0;},
    fd_fdstat_get:(fd,st)=>{const dv=DV();const e=proc.fds.get(fd);dv.setUint8(st, e&&e.kind==='pipe'?2:(fd<=2?2:4));dv.setUint16(st+2,0,true);dv.setBigUint64(st+8,0xffffffffffffffffn,true);dv.setBigUint64(st+16,0xffffffffffffffffn,true);return 0;},
    fd_fdstat_set_flags:()=>0,
    fd_prestat_get:()=>8, fd_prestat_dir_name:()=>8,
    fd_filestat_get:(fd,p)=>{U8().fill(0,p,p+64);return 0;},
    path_filestat_get:()=>44,
    fd_read:(fd,iovs,n,nread)=>{
      // resume of a blocked pipe read: deliver the woken bytes
      if(proc.pendingRead){ proc.inst.exports.asyncify_stop_rewind(); c.rewinding=false; const {ptr,bytes,nreadPtr}=proc.pendingRead; proc.pendingRead=null; U8().set(bytes,ptr); DV().setUint32(nreadPtr,bytes.length,true); return 0; }
      const dv=DV(); const p=dv.getUint32(iovs,true), l=dv.getUint32(iovs+4,true);
      const e=proc.fds.get(fd);
      if(e && e.kind==='pipe'){
        const pp=pipes.get(e.pipeId);
        if(pp.queued>0){ const b=takeUpTo(pp,l); U8().set(b,p); dv.setUint32(nread,b.length,true); return 0; }
        if(pp.writers===0){ dv.setUint32(nread,0,true); return 0; }   // EOF
        dv.setUint32(nread,0,true); c.reason='piperead'; c.pipeReq={pp, ptr:p, len:l, nreadPtr:nread}; initHdr(proc.MAIN_BUF,MAIN_SIZE); proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF); return 0;
      }
      dv.setUint32(nread,0,true); return 0;   // stdin EOF
    },
    fd_write:(fd,iovs,n,nw)=>{const dv=DV(),u8=U8();let w=0;for(let i=0;i<n;i++){const p=dv.getUint32(iovs+i*8,true),l=dv.getUint32(iovs+i*8+4,true);w+=writeFd(fd,u8.subarray(p,p+l));}DV().setUint32(nw,w,true);return 0;},
    fd_seek:(fd,o,wh,no)=>{DV().setBigUint64(no,0n,true);return 70;},
    fd_tell:(fd,p)=>{DV().setBigUint64(p,0n,true);return 0;},
    fd_close:(fd)=>{ closeFd(proc,fd); return 0; },
    fd_readdir:()=>8, path_open:()=>44, path_readlink:()=>44, path_rename:()=>44, path_unlink_file:()=>44,
    poll_oneoff:(a,b,n,nev)=>{DV().setUint32(nev,0,true);return 0;},
    proc_exit:(code)=>{ throw new Exit(code); },
  };
  const npUnwind=(reason)=>{ if(c.rewinding){proc.inst.exports.asyncify_stop_rewind();c.rewinding=false;return c.resume;} c.reason=reason; initHdr(proc.MAIN_BUF,MAIN_SIZE); proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF); return 0; };
  const nimbus_proc = {
    setjmp:(env)=>{ if(c.rewinding){proc.inst.exports.asyncify_stop_rewind();c.rewinding=false;return;} c.reason='capture';c.captureEnv=env;const idx=c.nextSlot++;if(idx>=NSLOT)throw new Error('slots');const dv=DV();dv.setInt32(env,idx,true);dv.setInt32(env+4,0,true);initHdr(slotAddr(idx),SLOT_SIZE);proc.inst.exports.asyncify_start_unwind(slotAddr(idx)); },
    longjmp:(env,val)=>{ if(c.rewinding){proc.inst.exports.asyncify_stop_rewind();c.rewinding=false;return;} c.reason='longjmp';c.ljEnv=env;c.ljVal=val;initHdr(proc.MAIN_BUF,MAIN_SIZE);proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF); },
    fork:()=>{ if(c.rewinding){proc.inst.exports.asyncify_stop_rewind();c.rewinding=false;return c.resume;} c.reason='fork'; initHdr(proc.MAIN_BUF,MAIN_SIZE); proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF); return 0; },
    vfork:()=>nimbus_proc.fork(),
    waitpid:(pid,statusPtr,opt)=>{ if(c.rewinding){proc.inst.exports.asyncify_stop_rewind();c.rewinding=false; if(c.waitStatusPtr!=null){DV().setInt32(c.waitStatusPtr,c.resumeStatus,true);} return c.resume;} c.reason='waitpid';c.waitTarget=pid;c.waitStatusPtr=statusPtr;initHdr(proc.MAIN_BUF,MAIN_SIZE);proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);return 0; },
    execve:()=>{ return -2; }, // ENOENT: no external binaries staged locally (M2 covers exec)
    pipe:(fdsPtr)=>{ const id=newPipe(); const rfd=lowestFd(proc), r={kind:'pipe',pipeId:id,end:'r'}; proc.fds.set(rfd,r); const wfd=lowestFd(proc), w={kind:'pipe',pipeId:id,end:'w'}; proc.fds.set(wfd,w); const dv=DV();dv.setInt32(fdsPtr,rfd,true);dv.setInt32(fdsPtr+4,wfd,true); return 0; },
    dup:(o)=>{ const e=proc.fds.get(o); if(!e)return -9; const nf=lowestFd(proc); proc.fds.set(nf,{...e}); if(e.kind==='pipe')bumpPipe(e,1); return nf; },
    dup2:(o,n)=>{ const e=proc.fds.get(o); if(!e)return -9; if(o===n)return n; if(proc.fds.has(n))closeFd(proc,n); proc.fds.set(n,{...e}); if(e.kind==='pipe')bumpPipe(e,1); return n; },
    kill:()=>0, setpgid:()=>0, getpgid:()=>proc.pid, getppid:()=>proc.ppid,
    tcsetpgrp:()=>0, tcgetpgrp:()=>proc.pid, tcgetattr:()=>-1, tcsetattr:()=>0,
  };
  const env = { getpid:()=>proc.pid, getuid:()=>0, geteuid:()=>0, getgid:()=>0, getegid:()=>0, setuid:()=>0, setgid:()=>0, umask:()=>0o22, gethostname:(p,l)=>{U8().set(te.encode('nimbus'),p);return 0;}, dlopen:()=>0, dlsym:()=>0, dlclose:()=>0, dlerror:()=>0 };
  const wasiProxy=new Proxy(wasi,{get:(t,k)=>k in t?t[k]:((...a)=>{process.stderr.write(`[wasi missing] ${String(k)}\n`);return 0;})});
  proc.inst = new WebAssembly.Instance(mod,{ wasi_snapshot_preview1:wasiProxy, nimbus_proc, env });
  procs.set(pid, proc);
  return proc;
}

const OUT = { buf:'' };
function lowestFd(proc){ let fd=0; while(proc.fds.has(fd))fd++; return fd; }
function bumpPipe(e,d){ const pp=pipes.get(e.pipeId); if(e.end==='r')pp.readers+=d; else pp.writers+=d; }
function closeFd(proc,fd){ const e=proc.fds.get(fd); if(!e)return; proc.fds.delete(fd); if(e.kind==='pipe'){ bumpPipe(e,-1); wakePipe(pipes.get(e.pipeId)); } }
function takeUpTo(pp,max){ let need=max; const parts=[]; while(need>0&&pp.chunks.length){const ch=pp.chunks[0]; if(ch.length<=need){parts.push(ch);need-=ch.length;pp.chunks.shift();}else{parts.push(ch.subarray(0,need));pp.chunks[0]=ch.subarray(need);need=0;}} const total=max-need; pp.queued-=total; const o=new Uint8Array(total);let x=0;for(const p of parts){o.set(p,x);x+=p.length;} return o; }

// wake parked pipe readers when data/EOF available; deliver via pendingRead
function wakePipe(pp){ while(pp.readW.length && (pp.queued>0 || pp.writers===0)){ const w=pp.readW.shift(); const proc=w.proc; const req=proc.ctx.pipeReq; const bytes = pp.queued>0 ? takeUpTo(pp,req.len) : new Uint8Array(0); proc.pendingRead={ptr:req.ptr, bytes, nreadPtr:req.nreadPtr}; resumeProc(proc); } }

// ---- scheduler ----
function resumeProc(proc, before){ if(before)before(); proc.ctx.rewinding=true; proc.inst.exports.asyncify_start_rewind(proc.MAIN_BUF); runnable.push(proc); }

function setupArena(proc){ const base=proc.inst.exports.memory.buffer.byteLength; const need=MAIN_SIZE+NSLOT*SLOT_SIZE; proc.inst.exports.memory.grow(Math.ceil((need+HEADROOM)/PAGE)); proc.MAIN_BUF=base+HEADROOM; proc.SLOT0=proc.MAIN_BUF+MAIN_SIZE; }

function step(proc){
  const c=proc.ctx, ex=proc.inst.exports;
  let ret;
  try { ret = ex._start(); }
  catch(e){ if(e instanceof Exit){ finishProc(proc, e.code); return; } throw e; }
  if(c.reason===null){ finishProc(proc, 0); return; }   // _start returned = exit 0
  ex.asyncify_stop_unwind();
  const r=c.reason; c.reason=null;
  const dv=proc.DV();
  if(r==='capture'){ const idx=dv.getInt32(c.captureEnv,true); dv.setUint32(c.captureEnv+8, dv.getUint32(proc.slotAddr(idx),true), true); c.rewinding=true; ex.asyncify_start_rewind(proc.slotAddr(idx)); runnable.push(proc); }
  else if(r==='longjmp'){ const idx=dv.getInt32(c.ljEnv,true), hw=dv.getUint32(c.ljEnv+8,true); dv.setInt32(c.ljEnv+4,c.ljVal,true); dv.setUint32(proc.slotAddr(idx),hw,true); c.rewinding=true; ex.asyncify_start_rewind(proc.slotAddr(idx)); runnable.push(proc); }
  else if(r==='fork'){ doFork(proc); }
  else if(r==='waitpid'){ doWait(proc); }
  else if(r==='piperead'){ proc.ctx.pipeReq.pp.readW.push({proc}); wakePipe(proc.ctx.pipeReq.pp); }
  else throw new Error('unknown reason '+r);
}

function doFork(parent){
  const childPid=pidNext++;
  const childFds=new Map(); for(const[fd,e] of parent.fds){ childFds.set(fd,{...e}); if(e.kind==='pipe')bumpPipe(e,1); }
  const child=makeProc(childPid, parent.pid, childFds);
  // grow child to parent size, copy memory + globals, set arena addresses = parent's
  const pmem=parent.inst.exports.memory, cmem=child.inst.exports.memory;
  if(cmem.buffer.byteLength<pmem.buffer.byteLength) cmem.grow((pmem.buffer.byteLength-cmem.buffer.byteLength)/PAGE);
  new Uint8Array(cmem.buffer).set(new Uint8Array(pmem.buffer));
  for(const[k,v] of Object.entries(parent.inst.exports)) if(v instanceof WebAssembly.Global) child.inst.exports[k].value=v.value;
  child.MAIN_BUF=parent.MAIN_BUF; child.SLOT0=parent.SLOT0; child.ctx.nextSlot=parent.ctx.nextSlot;
  // resume child (fork returns 0) and parent (returns child pid)
  child.ctx.resume=0; child.ctx.rewinding=true; child.inst.exports.asyncify_start_rewind(child.MAIN_BUF); runnable.push(child);
  parent.ctx.resume=childPid; parent.ctx.rewinding=true; parent.inst.exports.asyncify_start_rewind(parent.MAIN_BUF); runnable.push(parent);
}

function doWait(proc){
  const t=proc.ctx.waitTarget;
  // find an exited child (t>0 specific, t<=0 any child)
  let pid=null;
  if(t>0){ if(exitStatus.has(t)) pid=t; }
  else { for(const [p,st] of exitStatus){ const cp=procs.get(p); if(!procs.has(p) || (cp&&cp.ppid===proc.pid)){ pid=p; break; } } }
  if(pid!=null){ const st=exitStatus.get(pid); exitStatus.delete(pid); proc.ctx.resume=pid; proc.ctx.resumeStatus=st; resumeProc(proc); }
  else waiters.push({proc, targetPid:t});
}

function finishProc(proc, code){
  const st=(code&0xff)<<8;
  procs.delete(proc.pid);
  // close its fds (release pipe ends -> peers get EOF)
  for(const fd of [...proc.fds.keys()]) closeFd(proc,fd);
  if(proc.ppid===0) rootExit=code;
  exitStatus.set(proc.pid, st);
  // wake a waiter for this pid (or any-child)
  for(let i=0;i<waiters.length;i++){ const w=waiters[i]; if(w.targetPid===proc.pid || w.targetPid<=0){ waiters.splice(i,1); w.proc.ctx.resume=proc.pid; w.proc.ctx.resumeStatus=st; exitStatus.delete(proc.pid); resumeProc(w.proc); break; } }
}

// ---- run ----
const root=makeProc(pidNext++, 0, new Map([[0,{kind:'stdin'}],[1,{kind:'stdout'}],[2,{kind:'stderr'}]]));
setupArena(root);
runnable.push(root);
let steps=0;
try{ while(runnable.length){ if(++steps>2000000) throw new Error('runaway'); step(runnable.shift()); } }
catch(e){ process.stderr.write('DRIVER ERROR: '+String(e).split(String.fromCharCode(10))[0]+'\nLAST: '+(globalThis.__CALLS||[]).slice(-30).join(' ')+'\n'); }
process.stdout.write('=== bash stdout ===\n'+OUT.buf);
process.stdout.write(`=== root exit: ${rootExit} · procs spawned: ${pidNext-100} · pipes: ${pipeNext-1} · steps: ${steps} ===\n`);
process.exit(rootExit===0?0:1);
