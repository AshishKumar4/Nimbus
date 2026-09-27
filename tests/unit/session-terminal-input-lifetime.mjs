#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { WebSocketTerminal } from '../../packages/worker/src/facets/ws-terminal.ts';
import { wsMessage } from '../../packages/worker/src/session/ws.ts';
import { testBox } from './lib/test-box.mjs';

const frames=[];
let attachment={kind:'shell',seenAt:Date.now()};
const socket={readyState:1,send(value){frames.push(JSON.parse(value));},deserializeAttachment:()=>attachment,serializeAttachment(value){attachment=value;},close(){}};
const terminal=new WebSocketTerminal(socket);
const box=await testBox();
box.shell.bindTerminal(terminal);
const tasks=[];
const host={shell:box.shell,kernel:box.kernel,terminal,ctx:{waitUntil(p){tasks.push(p);}},_wakeRebuild:null,processes:box.workspace.processes};
const input=(data)=>wsMessage(host,socket,JSON.stringify({type:'input',data}));
let release;
try {
  for(const stop of ['finish','interrupt']) {
    const entered=Promise.withResolvers();
    release=Promise.withResolvers();
    box.commands.registry.register('controlled',async(ctx)=>{
      ctx.signal.addEventListener('abort',()=>release.resolve('interrupt'),{once:true});
      entered.resolve();
      const how=await release.promise;
      await ctx.stdout.write(`CONTROLLED_${how}\n`);
      return how==='interrupt'?130:0;
    });
    const before=tasks.length;
    await input('controlled\r');
    await entered.promise;
    let completed=false;
    const completion=Promise.all(tasks.slice(before)).then(()=>{completed=true;});
    await Promise.resolve();
    assert.equal(completed,false,'the handed-off completion is still pending while the command is held');
    if(stop==='interrupt') await input('\x03');
    else release.resolve('finish');
    await completion;
    assert.equal(completed,true);
    terminal.flushNow();
    assert.ok(frames.some(f=>f.data?.includes(`CONTROLLED_${stop}`)));
  }

  const gates=[Promise.withResolvers(),Promise.withResolvers()];
  const received=[];
  const detach=terminal.attachRepl(async(data)=>{
    const index=received.length;
    received.push(data);
    await gates[index].promise;
  });
  const before=tasks.length;
  await input('a');
  await input('b');
  assert.deepEqual(received,['a','b'],'a pending input must not serialize later TUI input');
  let replCompleted=false;
  const replCompletion=Promise.all(tasks.slice(before)).then(()=>{replCompleted=true;});
  await Promise.resolve();
  assert.equal(replCompleted,false,'REPL input completion is still pending while its work is held');
  gates[1].resolve();gates[0].resolve();
  await replCompletion;
  detach();

  const error=new Error('terminal callback failed');
  terminal.onData(async()=>{throw error;});
  await assert.rejects(terminal.sendData('direct'),e=>e===error,'direct callers receive callback rejection');
  const reported=[];
  const oldError=console.error;
  console.error=(...args)=>reported.push(args);
  try {
    const before=tasks.length;
    await input('websocket');
    await Promise.all(tasks.slice(before));
    terminal.flushNow();
    assert.ok(reported.some(args=>args.some(x=>String(x).includes(error.message))));
    assert.ok(frames.some(frame=>frame.data?.includes(error.message)),'failed input is visible to the client');
  } finally {console.error=oldError;}
  console.log('session-terminal-input-lifetime: command completion handed to waitUntil, Ctrl-C, concurrent REPL input and rejection');
} finally {
  release?.resolve('finish');
  terminal.close();
  await box.workspace.close();
}
