#!/usr/bin/env bun
// One browser jar, two session routes: exchange, HTTP and WS share exactly the
// cookie selected by the already parsed sid. Naming never replaces JWT pinning.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken, verifyNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { extractBearerToken } from '../../packages/worker/src/auth/middleware.ts';
const ids=['cookie-alpha','cookie-beta'];
const names=[];
const env={JWT_SECRET:'per-session-cookie-unit-signing-key',NIMBUS_PREVIEW_HOST_SUFFIX:'preview.test',NIMBUS_SESSION:{
  idFromName(name){names.push(name);return{name};},
  get(id){return{fetch:async request=>Response.json({name:id.name,path:new URL(request.url).pathname,upgrade:request.headers.get('Upgrade')}),
    _rpcConsumeAttachBootstrap:async()=>true};},
}};
const router=createNimbusHandler({auth:{mode:'enforce'}});
const ctx={waitUntil(){}};
const tokens=await Promise.all(ids.map(sid=>issueNimbusToken(env,{tn:'tenant',sub:'user',scopes:['session:attach'],sid})));
const jar=new Map();
for(const [index,sid] of ids.entries()){
  const response=await router.fetch(new Request(`https://nimbus.test/s/${sid}/?nimbus_token=${encodeURIComponent(tokens[index])}`),env,ctx);
  assert.equal(response.status,302);
  for(const cookie of response.headers.getSetCookie()){
    const pair=cookie.split(';',1)[0];const at=pair.indexOf('=');
    if(/Max-Age=0(?:;|$)/.test(cookie))jar.delete(pair.slice(0,at));else jar.set(pair.slice(0,at),pair.slice(at+1));
  }
}
const header=[...jar].map(([name,value])=>`${name}=${value}`).join('; ');
for(const sid of ids){
  for(const [path,extra] of [['api/stats',{}],['ws',{Upgrade:'websocket'}]]){
    const response=await router.fetch(new Request(`https://nimbus.test/s/${sid}/${path}`,{headers:{Cookie:header,...extra}}),env,ctx);
    assert.equal(response.status,200,`${sid} ${path} selects its own cookie, even after the other exchange`);
    assert.equal((await response.json()).name,`tenant:user:${sid}`);
  }
  const cookie=jar.get(`__Host-nimbus_token-${sid}`);
  assert.ok(cookie,'the __Host name includes the valid session id');
  assert.equal((await verifyNimbusToken(env,decodeURIComponent(cookie))).claims.sid,sid);
}
assert.equal(jar.size,2,'both attach credentials coexist');
const wrong=await router.fetch(new Request(`https://nimbus.test/s/${ids[0]}/api/stats`,{
  headers:{Cookie:`__Host-nimbus_token-${ids[0]}=${encodeURIComponent(tokens[1])}`},
}),env,ctx);
assert.equal(wrong.status,403);
assert.equal((await wrong.json()).code,'E_SESSION_PIN_MISMATCH','cookie naming does not relax sid pinning');
const legacy=await router.fetch(new Request(`https://nimbus.test/s/${ids[0]}/api/stats`,{headers:{Cookie:`__Host-nimbus_token=${tokens[0]}`}}),env,ctx);
assert.equal(legacy.status,401,'legacy global cookie is not a fallback credential');
const mixed=await router.fetch(new Request(`https://nimbus.test/s/${ids[0]}/api/stats`,{headers:{Cookie:`__Host-nimbus_token=${tokens[1]}; ${header}`}}),env,ctx);
assert.equal(mixed.status,200,'a pre-existing global cookie cannot contaminate the route cookie');
const preview=await router.fetch(new Request(`https://3000--${ids[0]}.preview.test/assets/x`,{headers:{Cookie:header}}),env,ctx);
assert.equal(preview.status,200,'preview host selects its parsed sid, not its application path');
assert.equal((await preview.json()).name,`tenant:user:${ids[0]}`);
const before=names.length;
for(const sid of ['bad%2Fsid','bad%3Bname','bad%0D%0Aname','x'.repeat(129)]){
  const response=await router.fetch(new Request(`https://nimbus.test/s/${sid}/?nimbus_token=${tokens[0]}`),env,ctx);
  assert.equal(response.status,400,'malformed sid rejected before constructing a cookie name or reaching a DO');
  assert.equal(response.headers.get('Set-Cookie'),null);
}
assert.equal(names.length,before);
assert.equal(extractBearerToken(new Request('https://nimbus.test/new',{headers:{Cookie:header}})),null,'unaddressed routes cannot select a session cookie');
console.log('session-cookie-per-sid: two-route HTTP/WS/preview selection, legacy and malformed ids passed');
