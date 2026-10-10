// Execute the real helper with only terminal/network/time boundaries fake.
// The 65-second, fourteen-request residency proof must survive consolidation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const driver = new URL('../behavioral/_driver.mjs', import.meta.url).href;
const helper = new URL('../behavioral/_framework-dev.mjs', import.meta.url).href;
for (const mode of ['healthy', 'rejected', 'exited']) {
  const ran = spawnSync(process.execPath, ['-e', `
    import { mock } from 'bun:test';
    let clock=0, calls=0, killed=0, closed=0;
    Date.now=()=>clock;
    const proc={exit:null,output:'process output',ws:{close(){closed++;}},signal(){killed++;this.exit={code:137};}};
    mock.module(${JSON.stringify(driver)},()=>({
      BASE:'https://fixture.test',stripAnsi:text=>text,requestHeaders:()=>({}),
      sleep:async ms=>{clock+=ms;}, connectProcessTerminal:async()=>proc,
    }));
    globalThis.fetch=async()=>{
      calls++;
      if(${JSON.stringify(mode)}==='exited'&&calls===2)proc.exit={code:1};
      return new Response(${JSON.stringify(mode)}==='rejected'&&calls===2?'rejected':'app',
        {status:${JSON.stringify(mode)}==='rejected'&&calls===2?502:200});
    };
    const terminal={buf:'',submission:null,commands:[],reset(){this.buf='';},cmd(command){this.commands.push(command);this.submission={end:null};},
      async waitFor(predicate){this.buf='[facet started (long-running): pid=7]';if(!predicate(this.buf))throw Error('unexpected waiter');}};
    const {launchFrameworkDev}=await import(${JSON.stringify(helper)});
    const result=await launchFrameworkDev({terminal,sid:'session',cwd:'/app',command:'dev',port:7441,accepts:r=>r.status===200&&r.body==='app'});
    console.log(JSON.stringify({ok:result.ok,clock,calls,killed,closed,commands:terminal.commands.length}));
  `], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(ran.status, 0, ran.stderr);
  const result = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.equal(result.commands, 1);
  if (mode === 'healthy') {
    assert.equal(result.ok, true);
    assert.ok(result.clock >= 65_000);
    assert.ok(result.calls >= 15, 'first successful request plus fourteen further accepted requests');
    assert.equal(result.closed, 0, 'successful process stays observed');
  } else {
    assert.equal(result.ok, false);
    assert.equal(result.calls, 2, 'a rejection or exit fails immediately, never waits out the window');
    assert.equal(result.closed, 1);
    assert.equal(result.killed, mode === 'rejected' ? 1 : 0);
  }
}
console.log('framework-dev-residency: strengthened request/window/alive/failure cleanup policy');
