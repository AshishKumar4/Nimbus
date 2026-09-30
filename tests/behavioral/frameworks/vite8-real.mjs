#!/usr/bin/env bun
// A real create-vite React/TS project, using its installed Vite 8 CLI (not
// Nimbus's bare `vite` command and not a configFile:false API wrapper).
// Generated config code can require a later launch; only that explicit
// next-launch boundary is retried. Assertions cover production output and
// actual HTML/TSX served through the public port route.
// HMR uses Nimbus's built-in vite path: inbound WebSocket upgrade to a Node
// guest server is not implemented in Nimbus, before or after native HTTP.
// That implementation gap is not a prohibition on a Workers adapter.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE,requestHeaders} from '../_driver.mjs';
import {launchFrameworkDev,NEXT_FRAMEWORK_LAUNCH} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('vite8-real');
const ROOT='/home/user/vite8-probe',APP=ROOT+'/app',PORT=5173,MAX=16;
const MARKER='vite8-real-'+Date.now();
function tail(s,n=20){return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');}
async function run(t,cmd,timeout){const r=await t.run(cmd+'; echo "___EXIT=$?___"',timeout);return {code:Number(r.output.match(/___EXIT=(\d+)___/)?.[1]??-1),output:stripAnsi(r.output)};}
async function readPort(sid,path){const r=await fetch(`${BASE}/s/${sid}/port/${PORT}/${path}`,{headers:requestHeaders(),signal:AbortSignal.timeout(30000)});return {status:r.status,body:await r.text()};}
const sid=await mintSession();console.log(`[vite8-real] sid=${sid} BASE=${BASE}`);
const t=new Terminal(sid);let proc;
try{
  await t.connect();await t.waitForPrompt(60000);
  await run(t,`mkdir -p ${ROOT} && cd ${ROOT}`,15000);
  const create=await run(t,'npm create vite@latest app -- --template react-ts --no-interactive 2>&1',240000);
  a.check('create-vite creates the real React/TS project',create.code===0,tail(create.output));
  if(create.code!==0)throw new Error('scaffold failed');
  const installed=await run(t,`cd ${APP} && npm install 2>&1`,400000);
  a.check('npm install succeeds without a rolldown refusal',installed.code===0&&!/note:\s*rolldown has no Workers-compatible build/.test(installed.output),tail(installed.output));
  if(installed.code!==0)throw new Error('install failed');
  const versions=await run(t,`grep '"version"' ${APP}/node_modules/vite/package.json ${APP}/node_modules/rolldown/package.json`,15000);
  a.check('the installed bundler is Vite 8',/"version":\s*"8\./.test(versions.output),tail(versions.output));
  // Authored input in a real scaffold: production output must carry this edit.
  await t.run(heredocCommand(APP+'/src/App.tsx',`import { useState } from 'react';\nimport './App.css';\nexport default function App(){const [count,setCount]=useState(0);return <main><h1>${MARKER}</h1><button onClick={()=>setCount(count+1)}>{count}</button></main>;}\n`),15000);
  let built,launches=0;
  for(let n=1;n<=MAX;n++){
    launches=n;built=await run(t,`cd ${APP} && ./node_modules/.bin/vite build 2>&1`,300000);
    console.log(`[vite8-real] build launch ${n}: exit ${built.code}`);
    if(built.code===0||!NEXT_FRAMEWORK_LAUNCH.test(built.output))break;
  }
  a.check('vite build exits 0 after bounded explicit staging relaunches',built.code===0,`launches=${launches}\n${tail(built.output,30)}`);
  const inspect=[
    "import fs from 'node:fs';",
    "const html=fs.readFileSync('dist/index.html','utf8');",
    "for(const file of fs.readdirSync('dist/assets')){if(!/\\.(js|css)$/.test(file))continue;const text=fs.readFileSync('dist/assets/'+file,'utf8');console.log('ASSET '+JSON.stringify({file,bytes:Buffer.byteLength(text),referenced:html.includes('/assets/'+file),nul:text.includes(String.fromCharCode(0)),dev:text.includes('jsxDEV'),marker:text.includes('"+MARKER+"')}));}",
  ].join('\n');
  await t.run(heredocCommand(APP+'/inspect-build.mjs',inspect),10000);
  const inspected=await run(t,`cd ${APP} && node inspect-build.mjs`,30000);
  const assets=[...inspected.output.matchAll(/^ASSET (\{.*\})$/gm)].map(m=>JSON.parse(m[1]));
  const js=assets.find(x=>x.file.endsWith('.js')),css=assets.find(x=>x.file.endsWith('.css'));
  a.check('dist HTML references production JS carrying the edited component',!!js&&js.referenced&&!js.dev&&js.marker,tail(inspected.output));
  a.check('CSS minification produces stylesheet bytes, not a whole wasm memory view',!!css&&css.referenced&&!css.nul&&css.bytes>0&&css.bytes<20000,tail(inspected.output));
  const again=await run(t,`cd ${APP} && ./node_modules/.bin/vite build 2>&1`,300000);
  a.check('a subsequent build succeeds at once',again.code===0,tail(again.output));

  const dev=await launchFrameworkDev({terminal:t,sid,cwd:APP,command:`./node_modules/.bin/vite --host 0.0.0.0 --port ${PORT}`,port:PORT,maxLaunches:MAX,accepts:r=>r.status===200&&r.body.includes('<div id="root">')&&r.body.includes('/@vite/client')});
  proc=dev.process;
  a.check('the project CLI serves index.html with the Vite client through the port route',dev.ok,`launches=${dev.attempt}; ${dev.last}\n${tail(dev.output,30)}`);
  if(dev.ok){
    const entry=await readPort(sid,'src/main.tsx');
    a.check('the served entry is transformed JavaScript, not raw TSX',entry.status===200&&entry.body.includes('jsxDEV')&&!entry.body.includes('<StrictMode>'),entry.body.slice(0,400));
    const app=await readPort(sid,'src/App.tsx');
    a.check('the served component carries the edited application content',app.status===200&&app.body.includes(MARKER),app.body.slice(0,400));
  }
}finally{
  if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
  await t.close();const d=await deleteSession(sid);a.check('probe session deleted',d.ok,`status=${d.status}`);
}
process.exit(a.summary().fail?1:0);
