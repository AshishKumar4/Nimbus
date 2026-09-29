#!/usr/bin/env bun
// Astro 7's real CLI, compiler and Markdown engine. Generated code is staged
// for a later launch, so the helper relaunches only on Nimbus's explicit
// next-launch diagnostic. ASTRO_KEY is generated once per app: without that
// upstream setting, Astro embeds a new random AES key in every manifest and
// no content-addressed next-launch compiler can converge.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE,sleep} from '../_driver.mjs';
import {launchFrameworkDev,frameworkProxyHost} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('astro-real');
const ROOT='/home/user/astro-probe', APP=ROOT+'/mvp', PORT=4321;
const MARKER='astro-real-'+Date.now();
const KEY=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
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
  await run(t,`mkdir -p ${APP}/.astro`,10000);
  await t.run(heredocCommand(APP+'/.astro/nimbus-probe-key',KEY),10000);
  await run(t,`chmod 600 ${APP}/.astro/nimbus-probe-key`,10000);
  await t.run(heredocCommand(APP+'/src/pages/proof.md','# Markdown proof\n\n**'+MARKER+'**\n'),10000);
  await t.run(heredocCommand(APP+'/src/pages/index.astro',`---\nimport { Content } from './proof.md';\n---\n<html lang="en"><head><title>Astro proof</title></head><body><Content /></body></html>\n`),10000);
  const command=`ASTRO_KEY=$(cat .astro/nimbus-probe-key) ./node_modules/.bin/astro dev --host 0.0.0.0 --port ${PORT} --allowed-hosts ${frameworkProxyHost}`;
  let result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command,port:PORT,maxLaunches:24,accepts:r=>r.status===200&&r.body.includes('<strong>'+MARKER+'</strong>')});
  proc=result.process;
  a.check('astro dev serves compiled .astro and satteri-rendered Markdown through the port route',result.ok,`launches=${result.attempt}; ${result.last}\n${tail(result.output,30)}`);
  if(result.ok){
    await t.run(heredocCommand(APP+'/src/pages/proof.md','# Markdown proof\n\n**'+MARKER+'-edited**\n'),10000);
    // Workers cannot compile newly generated SSR code in the existing realm.
    // Re-launching is explicit; this is not a claim of in-place WebSocket HMR.
    proc.signal('SIGKILL');for(let i=0;i<30&&!proc.exit;i++)await sleep(100);proc.ws.close();proc=null;
    result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command,port:PORT,maxLaunches:12,accepts:r=>r.status===200&&r.body.includes('<strong>'+MARKER+'-edited</strong>')});
    proc=result.process;
    a.check('the edited Markdown is rebuilt and served after an explicit relaunch',result.ok,`${result.last}\n${tail(result.output,30)}`);
  }
}finally{
  if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
  await t.close();const d=await deleteSession(sid);a.check('probe session deleted',d.ok,`status=${d.status}`);
}
process.exit(a.summary().fail?1:0);
