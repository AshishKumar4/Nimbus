#!/usr/bin/env bun
// Real Nuxt 4/Vite 8 SSR. --no-fork is Nuxt's supported in-process dev mode;
// no native subprocess, VM or rendering stub is substituted. The dev server
// runs once, as a user starts it.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE} from '../_driver.mjs';
import {launchFrameworkDev} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('nuxt-real');
const ROOT='/home/user/nuxt-probe', APP=ROOT+'/mvp', PORT=3000;
const MARKER='nuxt-rendered-'+Date.now();
function tail(s,n=20){return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');}
async function run(t,cmd,timeout){const r=await t.run(cmd+'; echo "___EXIT=$?___"',timeout);return {code:Number(r.output.match(/___EXIT=(\d+)___/)?.[1]??-1),output:stripAnsi(r.output)};}
const sid=await mintSession();console.log(`[nuxt-real] sid=${sid} BASE=${BASE}`);
const t=new Terminal(sid);let proc;
try{
  await t.connect();await t.waitForPrompt(60000);
  await run(t,`mkdir -p ${ROOT} && cd ${ROOT}`,15000);
  const create=await run(t,'npx --yes nuxi@latest init mvp -t minimal --no-install --gitInit=false --packageManager=npm 2>&1',240000);
  a.check('nuxi creates the real minimal project',create.code===0,tail(create.output));
  if(create.code!==0)throw new Error('scaffold failed');
  const installed=await run(t,`cd ${APP} && npm install 2>&1`,400000);
  a.check('npm install succeeds',installed.code===0,tail(installed.output));
  if(installed.code!==0)throw new Error('install failed');
  await t.run(heredocCommand(APP+'/app/app.vue',`<script setup>\nconst message = '${MARKER}';\n</script>\n<template><h1>{{ message }}</h1></template>\n`),10000);
  const result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command:`./node_modules/.bin/nuxt dev --no-fork --host 0.0.0.0 --port ${PORT}`,port:PORT,accepts:r=>r.status===200&&r.body.includes(MARKER)&&r.body.includes('__nuxt')});
  proc=result.process;
  a.check('nuxt dev SSR serves the Vue app through the port route on its first run',result.ok,`${result.last}\n${tail(result.output,35)}`);
}finally{
  if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
  await t.close();const d=await deleteSession(sid);a.check('probe session deleted',d.ok,`status=${d.status}`);
}
process.exit(a.summary().fail?1:0);
