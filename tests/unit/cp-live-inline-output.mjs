#!/usr/bin/env bun
// A managed child must publish its prompt while waiting for stdin, not
// return all its output only after it exits, and each byte reaches the
// parent once.
import assert from 'node:assert/strict';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const processes=new SessionProcessSupervisor();
const parent=processes.spawn('node',['parent.js'],'/home/user');
processes.openInput(parent.pid); // An inherited fd refers to the parent's actual live channel.
let manager;
manager=new FacetProcessManager({
 processes,
 vfsForProcess(){throw new Error('no script file is read');},
 commandRegistry:{async resolve(){return {kind:'facet-direct'};}},
 facetMgr:{async execStream(payload,_options,hooks){
   const {processPid}=JSON.parse(payload);
   hooks.onStdout(encoder.encode('question> '));
   const packet=await manager.cpReadStdin(processPid,1000);
   if(packet.ended) return 1;
   hooks.onStderr(encoder.encode('received '+decoder.decode(packet.data)));
   return 0;
 }},
});
const {childPid}=await manager.spawn({parentPid:parent.pid,command:'node',args:['interactive.js'],cwd:'/home/user',env:{},stdio:['inherit','inherit','inherit']});
try {
 const prompt=await manager.readOutput(childPid,1,0,500);
 assert.equal(decoder.decode(Buffer.concat(prompt.chunks.map(c=>c.data))),'question> ','prompt arrives before stdin');
 assert.equal(prompt.closed,false,'child is still waiting for its answer');
 await manager.stdinWrite(childPid,encoder.encode('yes\n'));
 const status=await manager.wait(childPid,1000);
 assert.equal(status.exitCode,0);
 const stdout=await manager.readOutput(childPid,1,0,0);
 const stderr=await manager.readOutput(childPid,2,0,0);
 assert.equal(decoder.decode(Buffer.concat(stdout.chunks.map(c=>c.data))),'question> ','the completion does not duplicate already streamed output');
 assert.equal(decoder.decode(Buffer.concat(stderr.chunks.map(c=>c.data))),'received yes\n');
}finally{await manager.stdinEnd(childPid);}
console.log('cp-live-inline-output: prompt before input, output exactly once');
