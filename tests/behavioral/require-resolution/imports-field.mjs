#!/usr/bin/env bun
// require-resolution/imports-field — Node-spec package.json#imports
// resolution for `#name` specifiers.
//
// Root cause (audit 2026-05-11-chalk-imports-field):
//
//   The runtime __resolveImportsField (node-shims.ts:2635) correctly
//   walks up to find the nearest package.json and uses resolveExports
//   to map "#name" → target path. BUT the prefetch's resolveRequireEx
//   (require-resolver.ts:398) doesn't handle "#name" specifiers — it
//   falls through to resolveNodeModuleEx which can't find the file.
//   Result: imports-field target is never shipped into the bundle.
//   __resolveFile returns null → __requireFrom throws
//     "Cannot find module '#name' (from ...)"
//   …despite the imports map being resolved correctly.
//
// Fix: extend resolveRequireEx to handle "#name" — walk up looking for
// the nearest package.json with `imports`, use resolveExports to map
// the spec to a relative target, return the resolved file so addFile
// ships it.
//
// Probe asserts:
//   1. synthetic-exact: {"#x":"./x.js"} + require("#x") → loads
//   2. synthetic-conditional: {"#x":{"node":"./n.js","default":"./d.js"}} → picks node variant under CJS conditions
//   3. synthetic-pattern: {"#x/*":"./src/*.js"} + require("#x/foo") → ./src/foo.js
//   4. synthetic-missing: require("#nonexistent") → clean error "Cannot find module"
//   5. wild-chalk: chalk@5's source/index.js loads (uses #ansi-styles + #supports-color)
//   6. wild-astro-progress: npm create astro@latest advances past chalk error

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[require-resolution/imports-field] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('require-resolution/imports-field');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

// ── Check 1: synthetic-exact ────────────────────────────────────────
//
// Package with imports:{"#x":"./x.js"}. Consumer requires the package
// entry which itself requires "#x". The "#x" must resolve to ./x.js
// relative to the package root.

await t.run('rm -rf /home/user/if-exact && mkdir -p /home/user/if-exact/node_modules/mypkg/lib', 5_000);
await writeFile('/home/user/if-exact/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './lib/index.js',
  imports: { '#x': './lib/x.js' },
}));
await writeFile('/home/user/if-exact/node_modules/mypkg/lib/x.js', "module.exports = 'X_VAL';");
await writeFile('/home/user/if-exact/node_modules/mypkg/lib/index.js', `
const x = require('#x');
module.exports = { kind: 'exact', x };
`);
await writeFile('/home/user/if-exact/consumer.js', `
const m = require('/home/user/if-exact/node_modules/mypkg/lib/index.js');
console.log('RESULT=' + m.x + ' kind=' + m.kind);
`);
const exactR = await t.run('node /home/user/if-exact/consumer.js', 30_000);
A.check(
  'synthetic-exact: require("#x") resolves to ./lib/x.js → X_VAL',
  /RESULT=X_VAL kind=exact/.test(exactR.output),
  `tail: ${exactR.output.slice(-500)}`,
);

// ── Check 2: synthetic-conditional ──────────────────────────────────
//
// imports:{"#x":{"node":"./n.js","default":"./d.js"}}. Nimbus's CJS
// runtime uses conditions ["require","node","default"], so the "node"
// branch wins.

await t.run('rm -rf /home/user/if-cond && mkdir -p /home/user/if-cond/node_modules/mypkg', 5_000);
await writeFile('/home/user/if-cond/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './index.js',
  imports: { '#x': { node: './n.js', default: './d.js' } },
}));
await writeFile('/home/user/if-cond/node_modules/mypkg/n.js', "module.exports = 'NODE_VAR';");
await writeFile('/home/user/if-cond/node_modules/mypkg/d.js', "module.exports = 'DEFAULT_VAR';");
await writeFile('/home/user/if-cond/node_modules/mypkg/index.js', `
const x = require('#x');
module.exports = { x };
`);
await writeFile('/home/user/if-cond/consumer.js', `
const m = require('/home/user/if-cond/node_modules/mypkg/index.js');
console.log('RESULT=' + m.x);
`);
const condR = await t.run('node /home/user/if-cond/consumer.js', 30_000);
A.check(
  'synthetic-conditional: {"node":...,"default":...} picks "node" variant under CJS conditions',
  /RESULT=NODE_VAR/.test(condR.output),
  `tail: ${condR.output.slice(-500)}`,
);

// ── Check 3: synthetic-pattern ──────────────────────────────────────
//
// imports:{"#x/*":"./src/*.js"} + require("#x/foo") → ./src/foo.js
// per Node's pattern-match spec.

await t.run('rm -rf /home/user/if-pat && mkdir -p /home/user/if-pat/node_modules/mypkg/src', 5_000);
await writeFile('/home/user/if-pat/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './index.js',
  imports: { '#x/*': './src/*.js' },
}));
await writeFile('/home/user/if-pat/node_modules/mypkg/src/foo.js', "module.exports = 'FOO_VAL';");
await writeFile('/home/user/if-pat/node_modules/mypkg/src/bar.js', "module.exports = 'BAR_VAL';");
await writeFile('/home/user/if-pat/node_modules/mypkg/index.js', `
const foo = require('#x/foo');
const bar = require('#x/bar');
module.exports = { foo, bar };
`);
await writeFile('/home/user/if-pat/consumer.js', `
const m = require('/home/user/if-pat/node_modules/mypkg/index.js');
console.log('RESULT=foo=' + m.foo + ' bar=' + m.bar);
`);
const patR = await t.run('node /home/user/if-pat/consumer.js', 30_000);
A.check(
  'synthetic-pattern: "#x/*":"./src/*.js" — #x/foo→./src/foo.js, #x/bar→./src/bar.js',
  /RESULT=foo=FOO_VAL bar=BAR_VAL/.test(patR.output),
  `tail: ${patR.output.slice(-500)}`,
);

// ── Check 4: synthetic-missing ──────────────────────────────────────
//
// require("#nonexistent") with no matching imports entry → clean error
// (not silent, not crashy — a Cannot-find-module).

await t.run('rm -rf /home/user/if-miss && mkdir -p /home/user/if-miss/node_modules/mypkg', 5_000);
await writeFile('/home/user/if-miss/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './index.js',
  imports: { '#x': './x.js' },
}));
await writeFile('/home/user/if-miss/node_modules/mypkg/x.js', "module.exports = 'X';");
await writeFile('/home/user/if-miss/node_modules/mypkg/index.js', `
try {
  require('#nonexistent');
  console.log('UNEXPECTED_LOAD');
} catch (e) {
  console.log('CAUGHT=' + (e && e.message ? e.message : String(e)));
}
module.exports = {};
`);
await writeFile('/home/user/if-miss/consumer.js', `
require('/home/user/if-miss/node_modules/mypkg/index.js');
`);
const missR = await t.run('node /home/user/if-miss/consumer.js', 30_000);
A.check(
  'synthetic-missing: require("#nonexistent") throws "Cannot find module" (clean error, not silent)',
  /CAUGHT=Cannot find module ['"]?#nonexistent/.test(missR.output),
  `tail: ${missR.output.slice(-500)}`,
);

// ── Check 5: wild-chalk ─────────────────────────────────────────────
//
// chalk@5 uses imports:{"#ansi-styles":"./source/vendor/ansi-styles/index.js",
// "#supports-color":{"node":"...","default":"..."}}. Loading
// chalk/source/index.js triggers both imports-field paths.

await t.run('rm -rf /home/user/if-chalk && mkdir -p /home/user/if-chalk && cd /home/user/if-chalk && npm init -y', 60_000);
await t.run('cd /home/user/if-chalk && npm install chalk@5', 240_000);
const chalkR = await t.run(
  `node -e "try { var c = require('/home/user/if-chalk/node_modules/chalk/source/index.js'); console.log('CHALK_LOADED type=' + typeof c.default + ' isFn=' + (typeof c.default === 'function')); } catch(e) { console.log('CHALK_ERR=' + e.message); }"`,
  30_000,
);
A.check(
  'wild-chalk: chalk/source/index.js loads (resolves #ansi-styles + #supports-color)',
  /CHALK_LOADED/.test(chalkR.output) && !/CHALK_ERR/.test(chalkR.output),
  `tail: ${chalkR.output.slice(-700)}`,
);

// ── Check 6: wild-astro-progress ────────────────────────────────────
//
// `npm create astro@latest` was previously failing at chalk's
// #ansi-styles import (cascading benefit from unhandled-rejection wave
// made the error visible). Post-fix that gate should be passed.
//
// We don't assert full scaffold success — chalk is one layer of
// many. We assert: NO "#ansi-styles" stack trace in the output.

await t.run('rm -rf /home/user/if-astro && mkdir -p /home/user/if-astro && cd /home/user/if-astro', 5_000);
const astroR = await t.run(
  'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes',
  600_000,
);
const astroOut = astroR.output;
A.check(
  'wild-astro-progress: NO "Cannot find module \'#ansi-styles\'" in create-astro output (gate passed)',
  !/Cannot find module ['"]?#ansi-styles/.test(astroOut),
  `tail: ${astroOut.slice(-700)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
