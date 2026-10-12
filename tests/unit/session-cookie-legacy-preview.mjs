#!/usr/bin/env bun
// Disabled token enforcement yields no verified credential, even when a
// browser carries unrelated cookies. Migration must not turn that into 500.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
for(const options of [
  {auth:{mode:'legacy'}}, {auth:{mode:'auto'}},
]){
  for(const cookie of ['theme=dark','__Host-nimbus_token=old-value','theme=dark; __Host-nimbus_token-sid=other']){
    const names=[];
    const env={NIMBUS_PREVIEW_HOST_SUFFIX:'preview.test',NIMBUS_SESSION:{
      idFromName(name){names.push(name);return name;},
      get(){return{fetch:async request=>Response.json({path:new URL(request.url).pathname,upgrade:request.headers.get('Upgrade')})};},
    }};
    const router=createNimbusHandler(options);
    for(const upgrade of [false,true]){
      const response=await router.fetch(new Request('https://3000--session-a.preview.test/app',{headers:{Cookie:cookie,...(upgrade?{Upgrade:'websocket'}:{})}}),env,{waitUntil(){}});
      assert.equal(response.status,200,'a legacy preview with cookies still forwards');
      assert.deepEqual(await response.json(),{path:'/port/3000/app',upgrade:upgrade?'websocket':null});
      assert.deepEqual(response.headers.getSetCookie(),[],'no verified credential means no migration');
    }
    assert.ok(names.every(name=>name.endsWith(':session-a')));
  }
}
console.log('session-cookie-legacy-preview: null credentials remain anonymous HTTP/WS forwards');
