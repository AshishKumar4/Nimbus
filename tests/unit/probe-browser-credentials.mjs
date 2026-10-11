// Execute the browser-auth adapter: credentials become host-scoped cookies,
// never page-wide headers that accompany third-party navigation or iframes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const template = new URL('../behavioral/_runtime-behavioral-template.mjs', import.meta.url).href;
const ran = spawnSync(process.execPath, ['-e', `
  const {applyProbeCookies}=await import(${JSON.stringify(template)});
  const observed={headers:[],cookies:[]};
  const page={async setExtraHTTPHeaders(h){observed.headers.push(h);},async setCookie(...c){observed.cookies.push(...c);}};
  await applyProbeCookies(page,'https://target.test');
  console.log(JSON.stringify(observed));
`], { encoding: 'utf8', env: { ...process.env, BASE: 'https://target.test', NIMBUS_PROBE_TOKEN: 'private-target-bearer', NIMBUS_PROBE_COOKIE: 'tenant=target' } });
assert.equal(ran.status, 0, ran.stderr);
const observed = JSON.parse(ran.stdout);
assert.deepEqual(observed.headers, [], 'no browser-global bearer headers may reach example.com');
assert.deepEqual(observed.cookies.map(({ name, value, domain, path }) => ({ name, value, domain, path })),
  [{ name: 'tenant', value: 'target', domain: 'target.test', path: '/' }]);
console.log('probe-browser-credentials: target-host cookies, never third-party bearer injection');
