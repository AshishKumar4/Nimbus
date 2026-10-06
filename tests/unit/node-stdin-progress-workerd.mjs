// @serial
import assert from 'node:assert/strict';
const repo=process.env.NIMBUS_BYTE_BASELINE_REPO??new URL('../..',import.meta.url).pathname;
const {startLocalProbe}=await import(`${repo}/tests/unit/lib/workerd-probe.mjs`);
const {localTerminal}=await import('./lib/workerd-probe.mjs');
const probe=await startLocalProbe({runtimes:[]});let terminal;
try {
 terminal=await localTerminal(probe,{install:[]});
 await terminal.run('yes | head -c 8388608 > /home/user/progress-input');
 for(const kind of ['redirect','pipe']) {
  const frames=[];const record=data=>{try{const m=JSON.parse(data.toString());if(m.type==='output')frames.push({at:performance.now(),text:m.data});}catch{}};
  terminal.terminal.ws.on('message',record);
  const node=`node -e 'console.log("PROGRESS_EARLY"); let n=0; process.stdin.on("data",d=>{n+=d.length}).on("end",()=>console.log("PROGRESS_DONE "+n))'`;
  const cmd=kind==='redirect'?`${node} < /home/user/progress-input`:`cat /home/user/progress-input | ${node}`;
  const sent=performance.now(),run=terminal.run(cmd,60000);
  const memory=(async()=>{await new Promise(r=>setTimeout(r,3000));const start=performance.now();await terminal.memory();return {ms:performance.now()-start,at:performance.now()};})();
  const result=await run,poll=await memory;terminal.terminal.ws.off('message',record);
  assert.equal(result.status,0,result.stdout);
  const early=frames.find(f=>f.text.includes('PROGRESS_EARLY')&&!f.text.includes('node -e'));
  const done=frames.find(f=>f.text.includes('PROGRESS_DONE')&&!f.text.includes('node -e'));
  assert.ok(early&&done&&done.at>early.at&&early!==done,`${kind}: progress must stream before completion; frames=${JSON.stringify(frames.map(f=>({ms:Math.round(f.at-sent),text:f.text.slice(-90)})))}`);
  assert.ok(poll.ms<1500,`${kind}: session remains responsive while fd0 is active (${Math.round(poll.ms)}ms)`);
 }
} finally {if(terminal)await terminal.close();await probe.stop();}
console.log('node-stdin-progress-workerd: redirected/piped stdin streams progress and does not gate the session');
