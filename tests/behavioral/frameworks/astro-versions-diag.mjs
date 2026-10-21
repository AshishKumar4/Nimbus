#!/usr/bin/env bun
// Scratch diagnosis only: hold Nimbus fixed while changing upstream Astro.
import {Terminal,mintSession,stripAnsi,makeAsserter,deleteSession,heredocCommand,BASE,connectProcessTerminal,sleep} from '../_driver.mjs';
import {launchFrameworkDev,frameworkProxyHost} from '../_framework-dev.mjs';
if(!process.env.BASE){console.error('FATAL: BASE env required');process.exit(2);}
const a=makeAsserter('astro-versions-diag');
for(const [version,newerFingerprint] of [['7.4.2',false],['7.4.1',false],['7.4.2',true]]){
  const ROOT='/home/user/astro-probe',APP=ROOT+'/mvp',PORT=4321;
  const MARKER='astro-diag-'+version+'-'+Date.now();
  const sid=await mintSession();console.log(`[astro-diag] version=${version} newerFingerprint=${newerFingerprint} sid=${sid} BASE=${BASE}`);
  const t=new Terminal(sid);let proc;
  try{
    await t.connect();await t.waitForPrompt(60000);
    await t.run(`mkdir -p ${ROOT} && cd ${ROOT}`,15000);
    if(version==='7.4.2'&&!newerFingerprint){
      const auditSource=`import process from 'node:process';\nimport tls from 'node:tls';\nimport zlib from 'node:zlib';\nimport dns from 'node:dns/promises';\nconsole.log(JSON.stringify({version:process.version,versions:process.versions,npmUserAgent:process.env.npm_config_user_agent??null,brotliBlockSwitch:zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH??null,tlsNonCanonical:['127.1','0127.0.0.1','0x7f.0.0.1'].map(host=>({host,result:tls.checkServerIdentity(host,{subjectaltname:'DNS:'+host})?.code??'accepted'}))}));\ntry{await dns.resolve4('example.com'+String.fromCharCode(0)+'.invalid');console.log('dnsNul accepted');}catch(e){console.log('dnsNul',e.code,e.message);}\n`;
      await t.run(heredocCommand(ROOT+'/node-audit.mjs',auditSource),10000);
      const audit=await t.run(`node --version && node ${ROOT}/node-audit.mjs 2>&1`,60000);
      console.log(`[astro-diag] runtime audit exit=${audit.exitCode}\n${stripAnsi(audit.output)}`);
    }
    const create=await t.run('npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes 2>&1',240000);
    console.log(`[astro-diag] scaffold version=${version} exit=${create.exitCode}\n${stripAnsi(create.output)}`);
    if(create.exitCode!==0)throw new Error('scaffold failed');
    const installed=await t.run(`cd ${APP} && npm install astro@${version} --save-exact 2>&1`,400000);
    console.log(`[astro-diag] install version=${version} exit=${installed.exitCode}\n${stripAnsi(installed.output)}`);
    if(installed.exitCode!==0)throw new Error('install failed');
    const versions=await t.run(`cat ${APP}/node_modules/astro/package.json && cat ${APP}/node_modules/@astrojs/markdown-satteri/package.json && cat ${APP}/node_modules/satteri/package.json`,15000);
    console.log(`[astro-diag] installed manifests version=${version}\n${stripAnsi(versions.output)}`);
    await t.run(heredocCommand(APP+'/src/pages/proof.md','# Markdown proof\n\n**'+MARKER+'**\n'),10000);
    await t.run(heredocCommand(APP+'/src/pages/index.astro',`---\nimport { Content } from './proof.md';\n---\n<html lang="en"><head><title>Astro proof</title></head><body><Content /></body></html>\n`),10000);
    let entry='./node_modules/.bin/astro';
    if(newerFingerprint){
      await t.run(heredocCommand(APP+'/astro-version.mjs',`import process from 'node:process';\nObject.defineProperty(process.versions,'node',{value:'22.23.4'});\nObject.defineProperty(process,'version',{value:'v22.23.4'});\nconsole.log('[astro-diag] injected fingerprint',process.version,process.versions.node);\nawait import('./node_modules/astro/bin/astro.mjs');\n`),10000);
      entry='node ./astro-version.mjs';
    }
    const command=`${entry} dev --host 0.0.0.0 --port ${PORT} --allowed-hosts ${frameworkProxyHost}`;
    const result=await launchFrameworkDev({terminal:t,sid,cwd:APP,command,port:PORT,accepts:r=>r.status===200&&r.body.includes('<strong>'+MARKER+'</strong>')});
    proc=result.process;
    console.log(`[astro-diag] result version=${version} pid=${result.pid} ok=${result.ok} last=${result.last}\n${stripAnsi(result.output)}`);
    if(!result.ok&&result.pid){
      const exited=await connectProcessTerminal(sid,result.pid);
      for(let i=0;i<20&&!exited.exit&&!exited.closed;i++)await sleep(100);
      console.log(`[astro-diag] process version=${version} pid=${result.pid} exit=${JSON.stringify(exited.exit)} closed=${exited.closed}\n${exited.output}`);
      exited.ws.close();
    }
    a.check(`Astro ${version} newerFingerprint=${newerFingerprint} serves compiled Astro and Markdown on first run`,result.ok,result.last);
  }finally{
    if(proc){try{proc.signal('SIGKILL');proc.ws.close();}catch{}}
    await t.close();const d=await deleteSession(sid);a.check(`Astro ${version} session deleted`,d.ok,`status=${d.status}`);
  }
}
process.exit(a.summary().fail?1:0);
