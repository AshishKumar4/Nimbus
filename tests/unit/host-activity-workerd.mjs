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
import {HostActivity,observeResidentConfig,HOST_WATCH_HEADER} from './activity.js';
const CODE={compatibilityDate:'2026-09-26',mainModule:'leaf.js',modules:{'leaf.js':\`import {DurableObject} from 'cloudflare:workers';
export class NimbusProcess extends DurableObject { startProcess(){return 'booted';} fetch(){return new Response('user response');} }\`}};
export class Host extends DurableObject {
  async run() {
    const make = async (name) => {
      const activity = new HostActivity(), lost=[];
      const key='watch-'+name;
      const leaf=this.env.LOADER.get(name,()=>observeResidentConfig(structuredClone(CODE),key)).getDurableObjectClass('NimbusProcess');
      const facet=this.ctx.facets.get(name,async()=>({class:leaf}));
      await facet.startProcess();
      let opens=0;
      activity.observe(signal=>{opens++;return facet.fetch(new Request('https://watch.invalid/',{signal,headers:{[HOST_WATCH_HEADER]:key}}));},error=>lost.push(error.message));
      return {activity,lost,facet,opens:()=>opens};
    };
    const active=await make('active');
    const a=active.activity.acquire(),b=active.activity.acquire();
    await Promise.all([a.ready,b.ready]);
    const shared=active.opens();a.release();b.release();
    await new Promise(r=>setTimeout(r,20));
    const afterCancel=await(await active.facet.fetch(new Request('https://user.invalid/'))).text();
    const c=active.activity.acquire();await c.ready;
    this.ctx.facets.abort('active',new Error('platform reset active actor'));
    for(let i=0;i<100&&!active.lost.length;i++)await new Promise(r=>setTimeout(r,10));
    c.release();
    const idle=await make('idle');
    const first=idle.activity.acquire();await first.ready;first.release();
    await new Promise(r=>setTimeout(r,20));
    this.ctx.facets.abort('idle',new Error('platform reset idle actor'));
    let admitted=false,error='';
    try{await idle.activity.run(()=>{admitted=true;});}catch(e){error=e.message;}
    return {shared,afterCancel,activeLost:active.lost,idleLost:idle.lost,admitted,error};
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
compatibilityDate="2026-09-26",durableObjectNamespaces=[(className="Host",uniqueKey="host-activity",enableSql=true)],durableObjectStorage=(inMemory=void),
bindings=[(name="HOST",durableObjectNamespace="Host"),(name="LOADER",workerLoader=())]))],
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
  assert.equal(result.activeLost.length,1,JSON.stringify(result)+'\n'+logs);
  assert.equal(result.admitted,false,'a reset while idle is rejected before work');
  assert.match(result.error,/restarted|reset/i);
  assert.equal(result.idleLost.length,1);
  console.log('host-activity-workerd: native abort, shared watch, active reset and idle incarnation change');
}finally{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
