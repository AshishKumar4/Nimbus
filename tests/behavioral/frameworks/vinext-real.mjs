#!/usr/bin/env bun
// Vinext 1.0's real Next.js App Router/Vite server. The app and vite.config
// match the files `vinext init` creates; no Next/RSC/SSR implementation is
// replaced. The dev server runs once, as a user starts it.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE} from '../_driver.mjs';
import {launchFrameworkDev} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('vinext-real');
const APP='/home/user/vinext-probe',PORT=3000,MARKER='vinext-rendered-'+Date.now();
const FILES={
  'package.json':JSON.stringify({name:'vinext-probe',private:true,type:'module',scripts:{dev:'vinext dev'},dependencies:{vinext:'^1.0.0',vite:'^8.0.0',react:'^19.2.6','react-dom':'^19.2.6','@vitejs/plugin-rsc':'^0.5.34','@vitejs/plugin-react':'^5.1.4','react-server-dom-webpack':'^19.2.6'}},null,2),
  'vite.config.ts':"import { defineConfig } from 'vite';\nimport vinext from 'vinext';\nexport default defineConfig({plugins:[vinext()]});\n",
  'app/layout.tsx':'export default function Layout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }\n',
  'app/page.tsx':`export default function Page(){ return <h1>${MARKER}</h1>; }\n`,
};
function tail(s,n=25){return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');}
const sid=await mintSession();console.log(`[vinext-real] sid=${sid} BASE=${BASE}`);
const t=new Terminal(sid);let proc;
try{
  await t.connect();await t.waitForPrompt(60000);
  await t.run(`mkdir -p ${APP}/app`,10000);
  for(const [name,text]of Object.entries(FILES))await t.run(heredocCommand(APP+'/'+name,text),10000);
  const installed=await t.run(`cd ${APP} && npm install 2>&1`,400000);
  const ok=installed.exitCode===0;
  a.check('the Vinext 1.0 app installs',ok,tail(installed.output));
  if(!ok)throw new Error('install failed');
  const result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command:`./node_modules/.bin/vinext dev --port ${PORT}`,port:PORT,accepts:r=>r.status===200&&r.body.includes(MARKER)});
  proc=result.process;
  a.check('vinext dev serves the App Router page through the port route on its first run',result.ok,`${result.last}\n${tail(result.output,35)}`);
}finally{
  if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
  await t.close();const d=await deleteSession(sid);a.check('probe session deleted',d.ok,`status=${d.status}`);
}
process.exit(a.summary().fail?1:0);
