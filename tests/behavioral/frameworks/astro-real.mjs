#!/usr/bin/env bun
// Astro 7's real CLI, compiler and Markdown engine, started once as a user
// starts it. An edit to a page shows on the next request to the same server,
// as it does under Node.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE,requestHeaders,sleep} from '../_driver.mjs';
import {launchFrameworkDev,frameworkProxyHost} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('astro-real');
const ROOT='/home/user/astro-probe', APP=ROOT+'/mvp', PORT=4321;
const MARKER='astro-real-'+Date.now();
function tail(s,n=16){return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');}
async function run(t,cmd,timeout){const r=await t.run(cmd+'; echo "___EXIT=$?___"',timeout);return {code:Number(r.output.match(/___EXIT=(\d+)___/)?.[1]??-1),output:stripAnsi(r.output)};}
const sid=await mintSession();console.log(`[astro-real] sid=${sid} BASE=${BASE}`);
const t=new Terminal(sid);let proc;
try{
  await t.connect();await t.waitForPrompt(60000);
  await run(t,`mkdir -p ${ROOT} && cd ${ROOT}`,15000);
  const create=await run(t,'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes 2>&1',240000);
  a.check('create-astro creates the real minimal project',create.code===0,tail(create.output));
  if(create.code!==0)throw new Error('scaffold failed');
  const installed=await run(t,`cd ${APP} && npm install 2>&1`,400000);
  a.check('npm install succeeds without rejecting the staged bindings',installed.code===0&&!/note:\s*(rolldown|satteri|@astrojs\/compiler-binding) has no Workers-compatible build/.test(installed.output),tail(installed.output));
  if(installed.code!==0)throw new Error('install failed');
  const version=await run(t,`grep '"version"' ${APP}/node_modules/astro/package.json`,15000);
  a.check('the installed framework is Astro 7',/"version":\s*"7\./.test(version.output),tail(version.output));
  await t.run(heredocCommand(APP+'/src/pages/proof.md','# Markdown proof\n\n**'+MARKER+'**\n'),10000);
  await t.run(heredocCommand(APP+'/src/pages/index.astro',`---\nimport { Content } from './proof.md';\n---\n<html lang="en"><head><title>Astro proof</title></head><body><Content /></body></html>\n`),10000);
  const command=`./node_modules/.bin/astro dev --host 0.0.0.0 --port ${PORT} --allowed-hosts ${frameworkProxyHost}`;
  let result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command,port:PORT,accepts:r=>r.status===200&&r.body.includes('<strong>'+MARKER+'</strong>')});
  proc=result.process;
  a.check('astro dev serves compiled .astro and satteri-rendered Markdown through the port route on its first run',result.ok,`${result.last}\n${tail(result.output,30)}`);
  if(result.ok){
    await t.run(heredocCommand(APP+'/src/pages/proof.md','# Markdown proof\n\n**'+MARKER+'-edited**\n'),10000);
    // The same server, reloaded: Astro recompiles the edited page, as it does
    // under Node. Its file watcher may take a moment to see the write.
    let edited={status:0,body:''};
    for(let i=0;i<30&&!edited.body.includes('<strong>'+MARKER+'-edited</strong>');i++){
      edited=await fetch(`${BASE}/s/${sid}/port/${PORT}/`,{headers:requestHeaders(),signal:AbortSignal.timeout(30000)})
        .then(async(r)=>({status:r.status,body:await r.text()})).catch((e)=>({status:0,body:e.message}));
      if(!edited.body.includes('<strong>'+MARKER+'-edited</strong>'))await sleep(1000);
    }
    a.check('the running server serves the edited Markdown on reload',edited.status===200&&edited.body.includes('<strong>'+MARKER+'-edited</strong>'),`HTTP ${edited.status}: ${edited.body.slice(0,300)}\n${tail(proc.output,20)}`);
  }
}finally{
  if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
  await t.close();const d=await deleteSession(sid);a.check('probe session deleted',d.ok,`status=${d.status}`);
}
process.exit(a.summary().fail?1:0);
