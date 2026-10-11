// @serial
// @tier slow — native fetch cancellation and actor reset, not a promise mock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const main = `import {DurableObject} from 'cloudflare:workers';
import {HostActivity,hostResponse,observeResidentConfig,HOST_WATCH_HEADER} from './activity.js';
export class Peer extends DurableObject {
  watches=new Set();
  codes=[];
  replyErrors=[];
  status(){return {watches:this.watches.size,codes:this.codes,replyErrors:this.replyErrors};}
  abortSelf(){this.ctx.abort('peer reset');}
  closeAll(){for(const socket of this.watches)socket.close(1000,'peer deliberately closed');}
  async fetch(request) {
    const [client,server]=Object.values(new WebSocketPair());
    this.watches.add(server);
    const ended=()=>{this.watches.delete(server);server.close();};
    server.addEventListener('close',event=>{
      this.codes.push(event.code);
      if(new URL(request.url).searchParams.has('badReply')){
        try{server.close(event.code,event.reason);}catch(error){this.replyErrors.push(error.message);return;}
      }
      ended();
    });
    server.addEventListener('error',ended);
    server.addEventListener('message',event=>server.send(event.data));
    server.accept();
    if(new URL(request.url).searchParams.has('delay'))await new Promise(resolve=>setTimeout(resolve,20));
    return new Response(null,{status:101,webSocket:client,headers:{'x-nimbus-host-incarnation':'peer'}});
  }
}
const CODE={compatibilityDate:'2026-09-26',mainModule:'leaf.js',modules:{'leaf.js':\`import {DurableObject} from 'cloudflare:workers';
export class NimbusProcess extends DurableObject { startProcess(){return 'booted';} fetch(){return new Response('user response');} }\`}};
export class Host extends DurableObject {
  activity;
  lease;
  passive;
  passiveAbort;
  losses=[];
  async startWatch(name){
    this.activity=new HostActivity();
    const target=this.activity.observe(signal=>this.env.PEER.get(this.env.PEER.idFromName(name)).fetch(new Request('https://peer.invalid/',{signal,headers:{Upgrade:'websocket'}})),error=>this.losses.push(error.message));
    this.lease=target.acquire();await this.lease.ready;
  }
  watchStatus(){return this.losses;}
  releaseWatch(){this.lease.release();}
  abortSelf(){this.ctx.abort('coordinator reset');}
  async startPassive(name,cancelPending=false){
    this.passiveAbort=new AbortController();
    const stub=this.env.PEER.get(this.env.PEER.idFromName(name));
    try{
      const pending=stub.fetch(new Request('https://peer.invalid/'+(cancelPending?'?delay':''),{signal:this.passiveAbort.signal,headers:{Upgrade:'websocket'}}));
      if(cancelPending)this.passiveAbort.abort();
      const response=await pending;
      this.passive=response.webSocket;
    }finally{stub[Symbol.dispose]?.();}
    return this.passive.readyState;
  }
  releasePassive(){this.passiveAbort.abort();}
  async run() {
    const make = async (name) => {
      const activity = new HostActivity(), lost=[];
      const key='watch-'+name;
      const leaf=this.env.LOADER.get(name,()=>observeResidentConfig(structuredClone(CODE),key)).getDurableObjectClass('NimbusProcess');
      const facet=this.ctx.facets.get(name,async()=>({class:leaf}));
      await facet.startProcess();
      let opens=0;
      const target=activity.observe(signal=>{opens++;return facet.fetch(new Request('https://watch.invalid/',{signal,headers:{[HOST_WATCH_HEADER]:key}}));},error=>lost.push(error.message));
      return {activity,target,lost,facet,opens:()=>opens};
    };
    const active=await make('active');
    const a=active.target.acquire(),b=active.target.acquire();
    await Promise.all([a.ready,b.ready]);
    const shared=active.opens();a.release();b.release();
    await new Promise(r=>setTimeout(r,20));
    const afterCancel=await(await active.facet.fetch(new Request('https://user.invalid/'))).text();
    const wrong=await active.facet.fetch(new Request('https://watch.invalid/',{headers:{[HOST_WATCH_HEADER]:'wrong-capability'}}));
    const rejectedCapability={body:await wrong.text(),incarnation:wrong.headers.get('x-nimbus-host-incarnation')};
    const c=active.target.acquire();await c.ready;
    this.ctx.facets.abort('active',new Error('platform reset active actor'));
    for(let i=0;i<100&&!active.lost.length;i++)await new Promise(r=>setTimeout(r,10));
    c.release();
    const idle=await make('idle');
    const first=idle.target.acquire();await first.ready;first.release();
    await new Promise(r=>setTimeout(r,20));
    this.ctx.facets.abort('idle',new Error('platform reset idle actor'));
    let admitted=false,error='';
    const validation=idle.target.acquire();
    try{await validation.ready;admitted=true;}catch(e){error=e.message;}finally{validation.release();}
    const experiments=[];
    for(const options of [
      {name:'activity-dispose',activity:true,dispose:true},
      {name:'activity-no-dispose',activity:true},
      {name:'activity-delay',activity:true,delay:true},
      {name:'activity-echo',activity:true,echo:true},
      {name:'direct-close'},
      {name:'direct-empty-close',emptyClose:true},
      {name:'invalid-reply-control',activity:true,badReply:true},
    ]){
      const stub=this.env.PEER.get(this.env.PEER.idFromName(options.name));
      const activity=new HostActivity(),losses=[];
      let socket,lease;
      const open=async(signal)=>{
        if(options.dispose)signal.addEventListener('abort',()=>stub[Symbol.dispose]?.(),{once:true});
        const response=await stub.fetch(new Request('https://peer.invalid/'+(options.badReply?'?badReply':''),{signal,headers:{Upgrade:'websocket'}}));
        socket=response.webSocket;return response;
      };
      if(options.activity){const target=activity.observe(open,error=>losses.push(error.message));lease=target.acquire();await lease.ready;}
      else{await open();socket.accept();}
      if(options.echo){
        const echo=new Promise((resolve,reject)=>{socket.addEventListener('message',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
        socket.send(options.name);await echo;
      }
      if(options.delay)await new Promise(resolve=>setTimeout(resolve,20));
      if(lease)lease.release();else if(options.emptyClose)socket.close();else socket.close(1000,'direct release');
      let remote;
      for(let i=0;i<100;i++){
        remote=await this.env.PEER.get(this.env.PEER.idFromName(options.name)).status();
        if(options.badReply?remote.replyErrors.length:remote.watches===0)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      experiments.push({...options,remote,losses});
    }
    const resetCases=[];
    for(const cause of ['coordinator-reset','peer-reset','peer-close','activity-release']){
      const owner=this.env.HOST.get(this.env.HOST.idFromName(cause));
      const peer=this.env.PEER.get(this.env.PEER.idFromName(cause));
      await owner.startWatch(cause);
      let resetError;
      try{
        if(cause==='coordinator-reset')await owner.abortSelf();
        else if(cause==='peer-reset')await peer.abortSelf();
        else if(cause==='peer-close')await peer.closeAll();
        else await owner.releaseWatch();
      }catch(error){resetError=error.message;}
      let remote,losses;
      for(let i=0;i<100;i++){
        remote=await this.env.PEER.get(this.env.PEER.idFromName(cause)).status();
        losses=cause==='coordinator-reset'?[]:await owner.watchStatus();
        if(cause==='peer-reset'||cause==='peer-close'?losses.length:remote.watches===0)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      resetCases.push({cause,resetError,remote,losses});
    }
    const streamCases=[];
    for(const ending of ['eof','cancel','partial-cancel','error']){
      const activity=new HostActivity();let watches=0,output,sourceCancelled=false,settled=false;
      const target=activity.observe(async()=>new Response(new ReadableStream({start(){watches++;},cancel(){watches--;}}),{headers:{'x-nimbus-host-incarnation':'stream'}}),()=>{});
      const ctx={waitUntil:task=>this.ctx.waitUntil(task.finally(()=>{settled=true;}))};
      const response=await hostResponse(ctx,target,new Request('https://stream.invalid/'),async()=>new Response(new ReadableStream({start(controller){output=controller;},cancel(){sourceCancelled=true;}}),{headers:{'Content-Length':'3'}}));
      const atHeaders=watches,reader=response.body.getReader();
      if(ending==='cancel')await reader.cancel();
      else if(ending==='partial-cancel'){output.enqueue(new Uint8Array([1]));await reader.read();await reader.cancel();}
      else{
        output.enqueue(new Uint8Array([1,2,3]));await reader.read();
        if(ending==='eof'){output.close();await reader.read();}
        else{output.error(new Error('source failed'));await reader.read().catch(()=>{});}
      }
      reader.releaseLock();
      for(let i=0;i<100&&(watches||!settled);i++)await new Promise(resolve=>setTimeout(resolve,1));
      streamCases.push({ending,atHeaders,after:watches,sourceCancelled,settled,length:response.headers.get('Content-Length')});target.close();
    }
    const passiveCases=[];
    for(const cause of ['release','coordinator-reset','peer-reset','pending-release']){
      const name='passive-'+cause,owner=this.env.HOST.get(this.env.HOST.idFromName(name)),peer=this.env.PEER.get(this.env.PEER.idFromName(name));
      let state;try{state=await owner.startPassive(name,cause==='pending-release');}catch{}
      const before=await peer.status();
      try{if(cause==='release')await owner.releasePassive();else if(cause==='coordinator-reset')await owner.abortSelf();else if(cause==='peer-reset')await peer.abortSelf();}catch{}
      let after;
      for(let i=0;i<100;i++){after=await this.env.PEER.get(this.env.PEER.idFromName(name)).status();if(after.watches===0)break;await new Promise(resolve=>setTimeout(resolve,10));}
      passiveCases.push({cause,state,before:before.watches,after:after.watches});
    }
    return {shared,afterCancel,rejectedCapability,activeLost:active.lost,idleLost:idle.lost,admitted,error,experiments,resetCases,streamCases,passiveCases};
  }
}
export default {fetch(request,env){return new URL(request.url).pathname==='/ready'?new Response('ready'):env.HOST.get(env.HOST.idFromName('proof')).run().then(value=>Response.json(value));}};`;
const require=createRequire(import.meta.url);
const binary=createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const dir=mkdtempSync(join(tmpdir(),'host-activity-'));
writeFileSync(join(dir,'main.js'),main);
writeFileSync(join(dir,'activity.js'),readFileSync(new URL('../../packages/fabric/dist/host-activity.js',import.meta.url)));
const free=net.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));
const port=free.address().port;await new Promise(r=>free.close(r));
writeFileSync(join(dir,'config.capnp'),`using Workerd=import "/workerd/workerd.capnp";
const config:Workerd.Config=(services=[(name="main",worker=(modules=[(name="main.js",esModule=embed"main.js"),(name="activity.js",esModule=embed"activity.js")],
compatibilityDate="2026-09-26",durableObjectNamespaces=[(className="Host",uniqueKey="host-activity",enableSql=true),(className="Peer",uniqueKey="host-activity-peer",enableSql=true)],durableObjectStorage=(inMemory=void),
bindings=[(name="HOST",durableObjectNamespace="Host"),(name="PEER",durableObjectNamespace="Peer"),(name="LOADER",workerLoader=())]))],
sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]);`);
const child=spawn(binary,['serve','config.capnp','--experimental'],{cwd:dir,stdio:['ignore','pipe','pipe']});
let logs='';child.stderr.on('data',part=>logs+=part);child.stdout.on('data',part=>logs+=part);
try{
  const base='http://127.0.0.1:'+port;
  for(const deadline=Date.now()+30000;;){
    try{await fetch(base+'/ready');break;}catch{}
    if(child.exitCode!==null||Date.now()>deadline)throw new Error(logs);
    await new Promise(r=>setTimeout(r,25));
  }
  const response=await fetch(base+'/run',{signal:AbortSignal.timeout(20000)});
  const body=await response.text();assert.equal(response.status,200,body+'\n'+logs);
  const result=JSON.parse(body);
  assert.equal(result.shared,1);
  assert.equal(result.afterCancel,'user response','releasing the watch leaves the program alive');
  assert.deepEqual(result.rejectedCapability,{body:'user response',incarnation:null},'a wrong capability cannot enter the native observation endpoint');
  assert.equal(result.activeLost.length,1,JSON.stringify(result)+'\n'+logs);
  assert.equal(result.admitted,false,'a reset while idle is rejected before work');
  assert.match(result.error,/restarted|reset/i);
  assert.equal(result.idleLost.length,1);
  for(const experiment of result.experiments){
    assert.equal(experiment.remote.watches,experiment.badReply?1:0,JSON.stringify(experiment)+'\n'+logs);
    assert.equal(experiment.losses.length,0,'deliberate release is not host loss');
    if(experiment.badReply){
      assert.ok(experiment.remote.codes.includes(1006),'fetch abort drops the upgrade transport before its close frame');
      assert.match(experiment.remote.replyErrors[0],/Invalid WebSocket close code: 1006/);
    }else assert.deepEqual(experiment.remote.replyErrors,[]);
  }
  for(const test of result.resetCases){
    assert.equal(test.remote.watches,0,JSON.stringify(test)+'\n'+logs);
    assert.equal(test.losses.length,test.cause==='peer-reset'||test.cause==='peer-close'?1:0,JSON.stringify(test));
  }
  for(const test of result.streamCases){
    assert.equal(test.atHeaders,1,JSON.stringify(test));
    assert.equal(test.after,0,JSON.stringify(test));
    assert.equal(test.settled,true,JSON.stringify(test));
    if(test.ending.includes('cancel'))assert.equal(test.sourceCancelled,true,JSON.stringify(test));
    assert.equal(test.length,'3','native ownership preserves declared length');
  }
  for(const test of result.passiveCases){
    if(test.cause!=='pending-release')assert.equal(test.before,1,JSON.stringify(test));
    assert.equal(test.after,0,JSON.stringify(test));
  }
  console.log('host-activity-workerd: native abort, shared watch, active reset and idle incarnation change');
}finally{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
