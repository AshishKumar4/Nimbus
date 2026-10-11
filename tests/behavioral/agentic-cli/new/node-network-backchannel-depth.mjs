#!/usr/bin/env bun
import { BASE, mintSession, deleteSession, Terminal, makeAsserter, termBody } from '../../_driver.mjs';

const a=makeAsserter('node-network-backchannel-depth'), sid=await mintSession(), t=new Terminal(sid);
const quote=(s)=>`'${s.replaceAll("'","'\\''")}'`;
const url=JSON.stringify(`${BASE}/?network-depth=1`);
try {
  await t.connect();await t.waitForPrompt(60_000);
  const one=`(async()=>{let completed=0;try{for(let i=0;i<50;i++){const r=await fetch(${url});await r.arrayBuffer();completed++;}console.log('FETCH_ONE_GUEST '+JSON.stringify({completed}));}catch(error){console.log('FETCH_ONE_GUEST '+JSON.stringify({completed,error:error.message}));process.exitCode=1;}})();`;
  const first=await t.run(`node -e ${quote(one)}`,180_000);
  const match=/^FETCH_ONE_GUEST (.+)$/m.exec(termBody(first.output));
  const got=match?JSON.parse(match[1].trim()):null;
  console.log('ONE_GUEST '+JSON.stringify({exitCode:first.exitCode,result:got,output:termBody(first.output)}));
  a.check('one guest completes fifty sequential fetches',got?.completed===50&&!got?.error,JSON.stringify(got));

  const each=`(async()=>{try{const r=await fetch(${url});await r.arrayBuffer();console.log('FETCH_SINGLE_OK');}catch(error){console.error('FETCH_SINGLE_ERROR '+error.message);process.exitCode=1;}})();`;
  const second=await t.run(`for i in $(seq 50); do echo FETCH_ITER=$i; node -e ${quote(each)}; done`,180_000);
  const output=termBody(second.output), completed=[...output.matchAll(/^FETCH_SINGLE_OK\r?$/gm)].length;
  console.log('FIFTY_GUESTS '+JSON.stringify({exitCode:second.exitCode,completed,output}));
  a.check('fifty guests each complete their fetch',completed===50&&!/Subrequest depth limit|FETCH_SINGLE_ERROR|the process was not started/.test(output),`${completed}/50`);
} finally {
  await t.close().catch(()=>{});
  a.check('session deleted',(await deleteSession(sid)).ok);
}
process.exit(a.summary().fail?1:0);
