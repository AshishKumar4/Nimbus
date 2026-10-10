// Diagnostic benchmark: timer/continuation latency and session CPU hot paths
// under the measured nine filesystem pollers. No generated profile is kept.
import {startLocalProbe,localTerminal} from './workerd-probe.mjs';
const boot=process.env.NIMBUS_TURN_BASELINE_ROOT?(await import(`${process.env.NIMBUS_TURN_BASELINE_ROOT}/tests/unit/lib/workerd-probe.mjs`)).startLocalProbe:startLocalProbe;
const probe=await boot({runtimes:[],vars:{NIMBUS_DIAG_TURN:'1'},inspector:process.env.NIMBUS_TURN_PROFILE!=='0'});
let t,cdp;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 t=await localTerminal(probe,{install:[]});
 const targets=probe.inspectorBase?await(await fetch(probe.inspectorBase+'/json')).json():[];
 const target=targets.find(x=>String(x.title).includes('probe'))??targets[0];
 if(target?.webSocketDebuggerUrl){
  const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let id=0;
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const done=pending.get(m.id);pending.delete(m.id);m.error?done?.reject(new Error(m.error.message)):done?.resolve(m.result);}});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  const call=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  cdp={ws,call};await call('Profiler.enable');await call('Profiler.setSamplingInterval',{interval:1000});
 }
 const samples=[];
 const sample=async phase=>{const at=performance.now(),m=await t.memory();samples.push({phase,requestMs:performance.now()-at,scheduling:m.loader.scheduling??{lastMs:m.loader.probeTimerMs}});};
 for(let i=0;i<4;i++){await sample('idle');await wait(250);}
 const code='const t=setInterval(()=>require("fs").promises.access("/home/user/nope").catch(()=>{}),100);console.log("POLLER_READY "+process.pid);setTimeout(()=>clearInterval(t),40000)';
 const running=t.run(Array.from({length:9},()=>`node -e '${code}' &`).join(' ')+' wait',120000);
 await t.terminal.waitFor(b=>(b.match(/^POLLER_READY \d+\r?$/gm)??[]).length===9,60000,'nine pollers running');
 if(cdp)await cdp.call('Profiler.start');
 for(let i=0;i<20;i++){await wait(500);await sample('nine-pollers');}
 await running;await sample('finished');
 console.log('SESSION_TURN_SAMPLES '+JSON.stringify(samples));
 if(cdp){const {profile}=await cdp.call('Profiler.stop'),counts=new Map();for(const id of profile.samples??[])counts.set(id,(counts.get(id)??0)+1);
  const hot=profile.nodes.map(n=>({function:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber,samples:counts.get(n.id)??0})).filter(n=>n.samples).sort((a,b)=>b.samples-a.samples).slice(0,25);
  console.log('SESSION_CPU_PROFILE '+JSON.stringify({samples:profile.samples?.length,hot}));
 }
}finally{cdp?.ws.close();if(t)await t.close();await probe.stop();}
