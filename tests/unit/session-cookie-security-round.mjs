#!/usr/bin/env bun
// One independently observable regression for each required security fix.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import * as auth from '../../packages/worker/src/auth/middleware.ts';
import { isNimbusIdComponent } from '../../packages/core/src/_shared/id-component.ts';
const context={waitUntil(){}};
const name=sid=>`__Host-nimbus_token-${sid}`;
const setup=()=>{
  const consumed=new Set();
  const env={JWT_SECRET:'cookie-security-round-secret',NIMBUS_SESSION:{
    idFromName(value){return value;},
    get(){return{fetch:async()=>Response.json({ok:true}),_rpcConsumeAttachBootstrap:async jti=>{
      if(consumed.has(jti))return false;consumed.add(jti);return true;
    }};},
  }};
  const router=createNimbusHandler({auth:{mode:'enforce'}});
  const request=(path,headers={})=>router.fetch(new Request(`https://cookie.test${path}`,{headers}),env,context);
  const token=(sid,extra={})=>issueNimbusToken(env,{tn:'tenant',sub:'user',sid,scopes:['session:attach'],...extra});
  return{env,consumed,request,token};
};
const cases=[
  ['capacity before consumption',async()=>{
    const {consumed,request,token}=setup();
    const bootstrap=await token('new-session',{scopes:['session:bootstrap'],jti:'single-use-credential'});
    const cookie=Array.from({length:24},(_,i)=>`${name(`held-${i}`)}=x`).join('; ');
    const path=`/s/new-session/?nimbus_token=${bootstrap}`;
    const refused=await request(path,{Cookie:cookie});
    assert.notEqual(refused.status,302);
    assert.equal(consumed.size,0,'capacity refusal must not touch the single-use credential');
    assert.equal((await request(path)).status,302,'the exact URL remains usable after clearing room');
  }],
  ['credential provenance',async()=>{
    const {request,token}=setup();
    const privileged=await token('session-a',{scopes:['session:attach','sandbox:use','files:write']});
    const legacy=await token('session-b');
    for(const [path,headers] of [
      ['/s/session-a/api/stats',{Authorization:`Bearer ${privileged}`,Cookie:`__Host-nimbus_token=${legacy}`}],
      [`/s/session-a/api/stats?nimbus_token=${privileged}`,{Cookie:`__Host-nimbus_token=${legacy}`}],
    ]){
      const response=await request(path,headers);
      assert.equal(response.status,200);
      assert.deepEqual(response.headers.getSetCookie(),[],'header/query authority must never become browser credentials');
    }
    const usedLegacy=await request('/s/session-b/api/stats',{Cookie:`__Host-nimbus_token=${legacy}`});
    assert.equal(usedLegacy.status,200);
    const migrationHeaders=usedLegacy.headers.getSetCookie();
    assert.ok(migrationHeaders[0]?.startsWith('__Host-nimbus_token=;')&&/Max-Age=0/.test(migrationHeaders[0]),'Chrome must remove the legacy bytes before receiving the new name');
    assert.ok(migrationHeaders[1]?.startsWith(`${name('session-b')}=`),'per-sid issuance follows legacy expiry');
    assert.ok(usedLegacy.headers.getSetCookie().some(value=>value.startsWith(`${name('session-b')}=`)),'a truly selected legacy cookie still migrates');
  }],
  ['sibling legacy preservation',async()=>{
    const {request,token}=setup();
    const legacy=await token('session-b');
    const attached=await request(`/s/session-a/?nimbus_token=${await token('session-a')}`,{Cookie:`__Host-nimbus_token=${legacy}`});
    assert.equal(attached.status,302);
    assert.equal(attached.headers.getSetCookie().some(value=>value.startsWith('__Host-nimbus_token=;')),false,'A must not delete B\'s only browser credential');
    const stillOwned=await request('/s/session-b/api/stats',{Cookie:`__Host-nimbus_token=${legacy}`});
    assert.equal(stillOwned.status,200);
  }],
  ['CHIPS byte quota',async()=>{
    const {env,consumed,request}=setup();
    const jar=new Map();let rejected=false;
    for(let i=0;i<20;i++){
      const sid=`s${i}`.padEnd(128,'s');
      const bootstrap=await issueNimbusToken(env,{tn:'t'.repeat(128),sub:'u'.repeat(128),sid,scopes:['session:bootstrap'],jti:`bootstrap-${i}`});
      const cookie=[...jar].map(([key,value])=>`${key}=${value}`).join('; ');
      const response=await request(`/s/${sid}/?nimbus_token=${bootstrap}`,{Cookie:cookie});
      if(response.status!==302){
        rejected=true;assert.equal(consumed.has(`bootstrap-${i}`),false,'CHIPS refusal does not consume bootstrap');break;
      }
      for(const value of response.headers.getSetCookie()){
        const pair=value.split(';',1)[0];const at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));
      }
      const storageBytes=[...jar].reduce((sum,[key,value])=>sum+key.length+value.length,0);
      assert.ok(storageBytes<=10_240,`issued ${storageBytes} name/value bytes; Chrome would evict a sibling`);
    }
    assert.equal(rejected,true,'the worst-case real cookies hit the CHIPS budget before the name limit');
  }],
  ['canonical sid grammar',async()=>{
    assert.equal('isValidNimbusTokenCookieSid' in auth,false,'no second session-id grammar at the cookie boundary');
    assert.equal('NIMBUS_TOKEN_COOKIE_SID_MAX' in auth,false,'no second session-id limit');
    for(const sid of ['sid','a.b','a_b-c','x'.repeat(128),'','x'.repeat(129),'a:b','a/b','a;b','a=b','a\r\nb']){
      if(isNimbusIdComponent(sid))assert.equal(auth.nimbusTokenCookieName(sid),name(sid));
      else assert.throws(()=>auth.nimbusTokenCookieName(sid));
    }
  }],
];
const failures=[];
for(const [label,run] of cases){try{await run();console.log(`PASS ${label}`);}catch(error){failures.push(label);console.error(`FAIL ${label}: ${error.message}`);}}
assert.deepEqual(failures,[],'every required security regression is closed');
