// @tier slow — drives a local workerd with nine filesystem-polling children
// @serial
import assert from 'node:assert/strict';
import {startLocalProbe,localTerminal} from './lib/workerd-probe.mjs';
const probe=await startLocalProbe({runtimes:[],vars:{NIMBUS_DIAG_TURN:'1'}});let t;
try {
 t=await localTerminal(probe,{install:[]});
 const inner=`const fs=require('fs'); const go=async()=>{for(;;){try{await fs.promises.access('/home/user/schedule-go');break;}catch{await new Promise(r=>setTimeout(r,100));}} const c=require('child_process').spawn('node',['-e','console.log(2)']);c.stdout.resume();c.on('error',e=>{console.log('REFUSAL '+e.code);process.exit(0)});c.on('close',()=>process.exit(0));};console.log('READY');go();`;
 const outer=`const fs=require('fs'),{spawn}=require('child_process');try{fs.unlinkSync('/home/user/schedule-go')}catch{}let ready=0,closed=0;for(let i=0;i<9;i++){const c=spawn('node',['-e',${JSON.stringify(inner)}]);let out='';c.stdout.on('data',d=>{out+=d;if(String(d).includes('READY')&&++ready===9)fs.promises.writeFile('/home/user/schedule-go','go');if(String(d).includes('REFUSAL'))console.log(String(d).trim())});c.on('close',()=>{if(++closed===9)console.log('SCHEDULE_DONE')});}`;
 const b64=Buffer.from(outer).toString('base64');await t.run(`node -e "require('fs').writeFileSync('/home/user/schedule-parent.js',Buffer.from('${b64}','base64'))"`);
 const result=await t.run('node /home/user/schedule-parent.js',120000);
 assert.equal(result.status,0,result.stdout);assert.match(result.stdout,/REFUSAL EAGAIN/);assert.match(result.stdout,/SCHEDULE_DONE/);
 const stats=(await t.memory()).loader.scheduling;console.log('SESSION_DEADLOCK_SCHEDULING '+JSON.stringify(stats));
 assert.ok(stats.decisions>0,'a deadlock decision was recorded');
 assert.ok(stats.decisionP95Ms<1000,`the measured nine-poller refusal is not parked on a starved timer (${stats.decisionP95Ms}ms)`);
}finally{if(t)await t.close();await probe.stop();}
