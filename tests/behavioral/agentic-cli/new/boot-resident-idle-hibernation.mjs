#!/usr/bin/env bun
import { mintSession, deleteSession, Terminal, makeAsserter, sleep, hasOutputLine, termBody } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

const a=makeAsserter('boot-resident-idle-hibernation'), sid=await mintSession();
let t=new Terminal(sid);
try {
  await t.connect();await t.waitForPrompt(60_000);
  await t.writeFile('/home/user/idle-server.js',"require('http').createServer((req,res)=>res.end('BOOT_IDLE_OK')).listen(3217);\n");
  const boot=await t.run('node /home/user/idle-server.js',60_000);
  a.check('HTTP resident returns its boot',boot.exitCode===0,termBody(boot.output).slice(-500));
  a.check('resident serves before idle',hasOutputLine(termBody((await t.run('curl -s http://localhost:3217/; echo')).output),'BOOT_IDLE_OK'));
  const before=(await diagMemory(sid))?.hib?.isolateGen;
  await t.close();
  // The existing two-minute uptime-proof timer must finish before idle is eligible.
  for(let n=0;n<15;n++)await sleep(10_000);
  t=new Terminal(sid);await t.connect();await t.waitForPrompt(30_000);
  const after=(await diagMemory(sid))?.hib?.isolateGen;
  a.check('idle boot resident releases coordinator for hibernation',typeof before==='number'&&typeof after==='number'&&after>before,`${before} -> ${after}`);
  const resumed=await t.run('curl -sS http://localhost:3217/; status=$?; echo; echo CURL_STATUS=$status');
  const response=termBody(resumed.output);
  a.check('resident still serves after wake',hasOutputLine(response,'BOOT_IDLE_OK')&&hasOutputLine(response,'CURL_STATUS=0'),response.slice(-1000));
} finally {
  await t.close().catch(()=>{});
  a.check('session deleted',(await deleteSession(sid)).ok);
}
process.exit(a.summary().fail?1:0);
