// @serial
// @tier slow — native fetch cancellation and actor reset, not a promise mock.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const main = `import {DurableObject} from 'cloudflare:workers';
import {HostActivity,observeResidentConfig,HOST_WATCH_HEADER,HOST_REQUEST_HEADER,HOST_INCARNATION_HEADER} from './activity.js';
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
export class NimbusProcess extends DurableObject { startProcess(){return 'booted';} handleHttpRequest(){return new Response('user response');} fetch(){return new Response('user response');} }\`}};
// A guest's answers as the HTTP hop to its host carries them: a declared length on a stream body (right, short, long), and an encoded body, sent manual or (as the Node shim does) automatic.
const FRAMED={compatibilityDate:'2026-09-26',mainModule:'leaf.js',modules:{'leaf.js':\`import {DurableObject} from 'cloudflare:workers';
const gzip=()=>new Response(new Blob(['hello hello']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
export class NimbusProcess extends DurableObject {
  startProcess(){return 'booted';}
  async handleHttpRequest(request){
    const path=new URL(request.url).pathname;
    if(path==='/length')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3,4,5]));c.close();}}),{headers:{'Content-Length':'5'}});
    if(path==='/short')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.close();}}),{headers:{'Content-Length':'5'}});
    if(path==='/long')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3,4,5]));c.close();}}),{headers:{'Content-Length':'2'}});
    if(path==='/gzip-manual')return new Response(await gzip(),{headers:{'Content-Encoding':'gzip'},encodeBody:'manual'});
    const bytes=new Uint8Array(await gzip());
    return new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),{headers:{'Content-Encoding':'gzip'}});
  }
}\`}};
export class Host extends DurableObject {
  activity;
  lease;
  passive;
  passiveAbort;
  losses=[];
  async startWatch(name){
    this.activity=new HostActivity();
    const target=this.activity.observe(signal=>this.env.PEER.get(this.env.PEER.idFromName(name)).fetch(new Request('https://peer.invalid/',{signal,headers:{Upgrade:'websocket'}})),error=>this.losses.push(error.message),'peer');
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
      const reopen=()=>this.ctx.facets.get(name,async()=>({class:leaf}));
      const facet=reopen();
      const pin=await facet.fetch(new Request('https://watch.invalid/',{headers:{[HOST_WATCH_HEADER]:key}}));
      const pinned=pin.headers.get(HOST_INCARNATION_HEADER);await pin.body.cancel();
      await facet.startProcess();
      let opens=0;
      const target=activity.observe(signal=>{opens++;return facet.fetch(new Request('https://watch.invalid/',{signal,headers:{[HOST_WATCH_HEADER]:key}}));},error=>lost.push(error.message),pinned);
      const data=()=>new Request('https://user.invalid/',{headers:{[HOST_REQUEST_HEADER]:key,[HOST_INCARNATION_HEADER]:pinned}});
      return {activity,target,lost,facet,reopen,data,key,opens:()=>opens};
    };
    const active=await make('active');
    const a=active.target.acquire(),b=active.target.acquire();
    await Promise.all([a.ready,b.ready]);
    const shared=active.opens();a.release();b.release();
    await new Promise(r=>setTimeout(r,20));
    const afterCancel=await(await active.facet.fetch(active.data())).text();
    const wrong=await active.facet.fetch(new Request('https://watch.invalid/',{headers:{[HOST_WATCH_HEADER]:'wrong-capability'}}));
    const rejectedCapability={body:await wrong.text(),incarnation:wrong.headers.get('x-nimbus-host-incarnation')};
    const c=active.target.acquire();await c.ready;
    this.ctx.facets.abort('active',new Error('platform reset active actor'));
    for(let i=0;i<100&&!active.lost.length;i++)await new Promise(r=>setTimeout(r,10));
    c.release();
    // A stub got again starts a fresh instance of the same class: the
    // original's pinned incarnation is refused there before any guest code.
    const stale=[];
    const replaced=active.reopen();
    for(const entry of ['handleHttpRequest','fetch']){
      const refused=await replaced[entry](active.data());
      stale.push({entry,status:refused.status,brand:refused.headers.get(HOST_REQUEST_HEADER)===active.key,body:await refused.text()});
    }
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
      if(options.activity){const target=activity.observe(open,error=>losses.push(error.message),'peer');lease=target.acquire();await lease.ready;}
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
    // What the facet host receives: the guest's declared length and its encoded bytes, as an RPC hop carried them.
    const framedLeaf=this.env.LOADER.get('framed',()=>observeResidentConfig(structuredClone(FRAMED),'framed-key')).getDurableObjectClass('NimbusProcess');
    const framedFacet=this.ctx.facets.get('framed',async()=>({class:framedLeaf}));
    const answer=async(path)=>{
      const response=await framedFacet.fetch(new Request('https://user.invalid'+path),{encodeResponseBody:'manual'});
      const seen={status:response.status,length:response.headers.get('content-length'),coding:response.headers.get('content-encoding')};
      try{
        const body=response.headers.get('content-encoding')==='gzip'?response.body.pipeThrough(new DecompressionStream('gzip')):response.body;
        const bytes=new Uint8Array(await new Response(body).arrayBuffer());
        return {...seen,body:seen.coding==='gzip'?new TextDecoder().decode(bytes):[...bytes]};
      }catch(error){return {...seen,error:String(error)};}
    };
    const framing={length:await answer('/length'),short:await answer('/short'),long:await answer('/long'),manual:await answer('/gzip-manual'),automatic:await answer('/gzip-automatic')};
    return {shared,afterCancel,rejectedCapability,stale,activeLost:active.lost,idleLost:idle.lost,admitted,error,experiments,resetCases,passiveCases,framing};
  }
}
export default {fetch(request,env){return new URL(request.url).pathname==='/ready'?new Response('ready'):env.HOST.get(env.HOST.idFromName('proof')).run().then(value=>Response.json(value));}};`;
const activity=await build({entryPoints:[new URL('../../packages/fabric/src/host-activity.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'error'});
const served=await servePlainWorkerd({name:'host-activity',files:{'main.js':main,'activity.js':activity.outputFiles[0].text},readyPath:'/ready',config:({port})=>`using Workerd=import "/workerd/workerd.capnp";
const config:Workerd.Config=(services=[(name="main",worker=(modules=[(name="main.js",esModule=embed"main.js"),(name="activity.js",esModule=embed"activity.js")],
compatibilityDate="2026-09-26",durableObjectNamespaces=[(className="Host",uniqueKey="host-activity",enableSql=true),(className="Peer",uniqueKey="host-activity-peer",enableSql=true)],durableObjectStorage=(inMemory=void),
bindings=[(name="HOST",durableObjectNamespace="Host"),(name="PEER",durableObjectNamespace="Peer"),(name="LOADER",workerLoader=())]))],
sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]);`});
const {base}=served;
try{
  const response=await fetch(base+'/run',{signal:AbortSignal.timeout(20000)});
  const body=await response.text();assert.equal(response.status,200,body+'\n'+served.logs());
  const result=JSON.parse(body);
  assert.equal(result.shared,1);
  assert.equal(result.afterCancel,'user response','releasing the watch leaves the program alive');
  assert.deepEqual(result.rejectedCapability,{body:'Not found',incarnation:null},'a wrong capability enters neither the native observation endpoint nor the guest');
  assert.deepEqual(result.stale,['handleHttpRequest','fetch'].map(entry=>({entry,status:410,brand:true,body:'the instance that ran this process was replaced'})),'a replaced instance refuses the pinned incarnation on both entrypoints before its guest runs');
  assert.equal(result.activeLost.length,1,JSON.stringify(result)+'\n'+served.logs());
  assert.equal(result.admitted,false,'a reset while idle is rejected before work');
  assert.match(result.error,/restarted|reset/i);
  assert.equal(result.idleLost.length,1);
  for(const experiment of result.experiments){
    assert.equal(experiment.remote.watches,experiment.badReply?1:0,JSON.stringify(experiment)+'\n'+served.logs());
    assert.equal(experiment.losses.length,0,'deliberate release is not host loss');
    if(experiment.badReply){
      assert.ok(experiment.remote.codes.includes(1006),'fetch abort drops the upgrade transport before its close frame');
      assert.match(experiment.remote.replyErrors[0],/Invalid WebSocket close code: 1006/);
    }else assert.deepEqual(experiment.remote.replyErrors,[]);
  }
  for(const test of result.resetCases){
    assert.equal(test.remote.watches,0,JSON.stringify(test)+'\n'+served.logs());
    assert.equal(test.losses.length,test.cause==='peer-reset'||test.cause==='peer-close'?1:0,JSON.stringify(test));
  }
  for(const test of result.passiveCases){
    if(test.cause!=='pending-release')assert.equal(test.before,1,JSON.stringify(test));
    assert.equal(test.after,0,JSON.stringify(test));
  }
  assert.deepEqual(result.framing.length,{status:200,length:'5',coding:null,body:[1,2,3,4,5]},'a declared length on a stream body reaches the host');
  // A wrong declaration reaches the host as declared, for the registry's FixedLengthStream to refuse: never rewritten to match the body, never a body cut to fit.
  for(const [sent,declared,got] of [['short','5',2],['long','2',5]]){
    const seen=result.framing[sent];
    assert.equal(seen.length,declared,sent+': '+JSON.stringify(seen));
    assert.ok(seen.error||seen.body.length===got,sent+': the body is not cut to its declaration: '+JSON.stringify(seen));
  }
  for(const sent of ['manual','automatic']){const {length:_length,...seen}=result.framing[sent];assert.deepEqual(seen,{status:200,coding:'gzip',body:'hello hello'},sent+': the host receives the encoded bytes the guest sent, decoded once');}
  console.log('host-activity-workerd: native abort, shared watch, active reset, idle incarnation change, stale data refusal and the HTTP hop keeping length and coding');
}finally{await served.stop();}
