#!/usr/bin/env bun
import { mintSession, deleteSession, Terminal, makeAsserter, sleep, termBody, hasOutputLine, stripAnsi } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

const a=makeAsserter('foreground-input-request-lifetime'), sid=await mintSession();
let t=new Terminal(sid);
const line=(value)=>new RegExp(`(?:^|\\n)${value}\\r?(?:\\n|$)`);
const raw=(data)=>t.ws.send(JSON.stringify({type:'input',data}));
try {
  await t.connect(); await t.waitForPrompt(60_000);
  const cat=t.run('echo CAT_WAITING; cat > /home/user/input.txt; echo CAT_ENDED',30_000);
  void cat.catch(()=>{});
  await t.waitFor(()=>line('CAT_WAITING').test(stripAnsi(t.buf)),10_000,'cat starts');
  raw('CAT_INPUT\r'); raw('\x04');
  a.check('blocked cat accepts later stdin and EOF',(await cat).exitCode===0);
  a.check('cat received the typed line',hasOutputLine(termBody((await t.run('cat /home/user/input.txt')).output),'CAT_INPUT'));

  const sleeping=t.run('echo SLEEP_WAITING; sleep 100',120_000);
  void sleeping.catch(()=>{});
  await t.waitFor(()=>line('SLEEP_WAITING').test(stripAnsi(t.buf)),10_000,'sleep starts');
  const started=Date.now(); t.send('\x03');
  await t.waitForPrompt(1000);
  const stopped=await sleeping;
  a.check('Ctrl-C finishes sleep within one second',Date.now()-started<=1000,`${Date.now()-started}ms`);
  a.check('sleep reports interrupt',stopped.exitCode===130,`${stopped.exitCode}`);

  t.cmd('echo DISCONNECT_READY; sleep 3; echo REPLAY_AFTER_DISCONNECT');
  await t.waitFor(()=>line('DISCONNECT_READY').test(stripAnsi(t.buf)),10_000,'disconnect fixture starts');
  await t.close(); await sleep(4000);
  t=new Terminal(sid); await t.connect(); await t.waitForPrompt(30_000);
  a.check('a disconnected command completes and replays',hasOutputLine(termBody(t.buf),'REPLAY_AFTER_DISCONNECT'),t.buf.slice(-500));
  const before=(await diagMemory(sid))?.hib?.isolateGen;
  await t.close();
  for(let n=0;n<7;n++)await sleep(10_000);
  t=new Terminal(sid);await t.connect();await t.waitForPrompt(30_000);
  const after=(await diagMemory(sid))?.hib?.isolateGen;
  a.check('completed command releases the object to hibernate',typeof before==='number'&&typeof after==='number'&&after>before,`${before} -> ${after}`);
  a.check('input after hibernation still works',hasOutputLine(termBody((await t.run('echo HIBERNATED_INPUT')).output),'HIBERNATED_INPUT'));
} finally {
  await t.close().catch(()=>{});
  a.check('session deleted',(await deleteSession(sid)).ok);
}
process.exit(a.summary().fail?1:0);
