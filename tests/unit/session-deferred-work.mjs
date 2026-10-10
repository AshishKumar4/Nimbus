#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {beginLoaderFetch,beginLoaderFetchWhenFree,bindProcessWaitGraph,setProcessBlocked,loaderLedgerStats,isDynamicWorkerDeadlock} from '../../packages/fabric/src/budgets.ts';
const ctx={},edges=new Map([[1,[2,3,4,5,6,7,8,9,10]]]);
for(let p=2;p<=10;p++)edges.set(p,[100+p]);
bindProcessWaitGraph(ctx,{children:p=>edges.get(p)??[],awaits:()=>null});
const ends=[];for(let p=1;p<=10;p++)ends.push(beginLoaderFetch(ctx,'holder-'+p,undefined,p));
const waiting=[];for(let p=2;p<=10;p++)waiting.push(beginLoaderFetchWhenFree(ctx,'child-'+p,{process:{pid:100+p}}).then(()=>null,e=>e));
const timer=globalThis.setTimeout;let timers=0;
globalThis.setTimeout=()=>{timers++;return 1;};
try {
 for(let p=1;p<=10;p++)setProcessBlocked(ctx,p,{blocked:true,frontier:loaderLedgerStats(ctx).news[p]?.issued??0,seq:1});
 for(let i=0;i<40;i++)await null;
 assert.equal(loaderLedgerStats(ctx).waiting,8,'one impossible child is refused even when the timer queue cannot fire');
 assert.equal(timers,0,'later-turn decisions do not enter the timer queue');
}finally{globalThis.setTimeout=timer;for(const end of ends)end();}
const replies=await Promise.all(waiting);
assert.equal(replies.filter(isDynamicWorkerDeadlock).length,1);
console.log('session-deferred-work: bounded decision, no timer dependency, exactly one refusal');
