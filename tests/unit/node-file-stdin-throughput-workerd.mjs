// @tier quiet-cpu — compares 48 MiB stdin route timings under a local workerd
// @serial
import assert from 'node:assert/strict';
const repo=process.env.NIMBUS_BYTE_BASELINE_REPO??new URL('../..',import.meta.url).pathname;
const {startLocalProbe}=await import(`${repo}/tests/unit/lib/workerd-probe.mjs`);
const {localTerminal}=await import('./lib/workerd-probe.mjs');
const probe=await startLocalProbe({runtimes:[]});let terminal;
try {
 terminal=await localTerminal(probe,{install:[]});
 const size=48*1048576;
 assert.equal((await terminal.run(`yes | head -c ${size} > /home/user/throughput-input`,300000)).status,0);
 const code='if(process.argv[2])require("fs").readFileSync(0);let n=0;process.stdin.on("data",d=>n+=d.length).on("end",()=>console.log("THROUGHPUT "+n))';
 const times={};
 for(const kind of ['file','pipe']) {
  const node=`node -e '${code}'`,cmd=kind==='file'?`${node} < /home/user/throughput-input`:`cat /home/user/throughput-input | ${node}`;
  const at=performance.now(),result=await terminal.run(cmd,300000);times[kind]=performance.now()-at;
  assert.equal(result.status,0,result.stdout);assert.match(result.stdout,new RegExp('^THROUGHPUT '+size+'$','m'));
 }
 console.log('STDIN_FILE_THROUGHPUT '+JSON.stringify(times));
 assert.ok(times.file<=times.pipe+1500,`a complete redirected source must not be slower than its pipe (file ${Math.round(times.file)}ms; pipe ${Math.round(times.pipe)}ms)`);
} finally {if(terminal)await terminal.close();await probe.stop();}
