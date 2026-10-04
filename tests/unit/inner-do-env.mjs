#!/usr/bin/env bun
// inner-do-env: a classic Durable Object binding inside a `wrangler dev`
// inner Worker is a local namespace (packages/fabric/src/inner-do-env.ts).
// The adapter runs here from its source, as the generated module runs it,
// over a fake of what it needs of `cloudflare:workers` (the isolate's env,
// RpcStub, WorkerEntrypoint) and a fake of the binding the loader passes.
// tests/unit/wrangler-dev-do-rpc-workerd.mjs runs it on the real workerd,
// against plain workerd's answers.
//
//   - each named binding in the env is replaced by a local namespace whose
//     ids and stubs answer at once; other env values stay;
//   - a stub is an RPC stub of a local target, with the object's `name` and
//     `id` as its own enumerable properties, and a prototype shaped as a
//     Durable Object stub's (no `dup` or Symbol.dispose; a constructor that
//     cannot be called; the tag 'DurableObject');
//   - the target relays what the runtime asks of it: a call to callOn, a
//     read (a thenable) to getOn, a path walked through own properties;
//   - the class check names the classes the main module does not export;
//   - innerWorkerModules makes the adapter the main module's first import on
//     the bundle's first line (after a hashbang), exporting the class check
//     under a name the bundle never spells, and leaves a Worker with no
//     binding as it is.

import assert from 'node:assert/strict';
import { innerDoAdapter, innerDoIdFromName, innerWorkerModules } from '../../packages/fabric/src/inner-do-env.ts';

const calls = [];
/** The binding the loader passes: one access to one object. */
const remote = {
  async callOn(id, path, args) { calls.push(['callOn', id, path, args]); return `called ${path.join('.')}(${args.join(',')})`; },
  async getOn(id, path) { calls.push(['getOn', id, path]); return `read ${path.join('.')}`; },
};

class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
/** An RPC stub: here, its target, kept. */
class RpcStub {
  constructor(target) { this.target = target; }
  dup() { return 'the platform dup'; }
  [Symbol.dispose]() {}
}
const other = { kept: true };
const env = { P: remote, GREETING: 'hi', OTHER: other };
const main = { P: class {}, notAClass: 1 };
// As the generated module runs them: from their source, so nothing outside them is reachable.
const fromSource = (fn) => (0, eval)(`(${fn.toString()})`);
const { NimbusDurableObjectClasses } = fromSource(innerDoAdapter)(
  fromSource(innerDoIdFromName), ['P', 'ABSENT'], main, { env, RpcStub, WorkerEntrypoint },
);

// The env: P is a local namespace; the rest as it was.
assert.notEqual(env.P, remote);
assert.equal(env.GREETING, 'hi');
assert.equal(env.OTHER, other);
assert.equal('ABSENT' in env, false, 'a name the env has no binding for is left alone');
assert.deepEqual(Object.keys(env.P), [], 'a namespace has no own enumerable properties');

// Ids and stubs answer at once.
const id = env.P.idFromName('x');
assert.equal(id.toString(), innerDoIdFromName('x'));
assert.equal(id.name, 'x');
assert.ok(env.P.idFromString(id.toString()).equals(id));
assert.match(env.P.newUniqueId().toString(), /^uniq:[0-9a-f]{32}$/);
const stub = env.P.get(id);
assert.ok(!(stub instanceof RpcStub), 'its prototype is a Durable Object stub\'s shape, not RpcStub\'s');
assert.deepEqual(Object.keys(stub), ['target', 'name', 'id']);
assert.equal(stub.name, 'x');
assert.equal(stub.id, id);
assert.equal(stub[Symbol.dispose], undefined, 'a stub is not disposable');
assert.equal(stub.dup, undefined, 'nor dup');
assert.equal(Object.prototype.toString.call(stub), '[object DurableObject]');
assert.equal(stub.constructor.name, 'DurableObject');
assert.equal(stub.constructor, Object.getPrototypeOf(stub).constructor);
assert.throws(() => stub.constructor(), { name: 'TypeError', message: 'Illegal constructor' });
assert.throws(() => new stub.constructor(), { name: 'TypeError', message: 'Illegal constructor' });
assert.equal(Object.getPrototypeOf(env.P.get(id)), Object.getPrototypeOf(stub), 'one prototype for every stub');
assert.equal(env.P.getByName('y').id.name, 'y');
const unique = env.P.get(env.P.newUniqueId());
assert.equal(unique.name, undefined);
assert.equal(unique.id.name, undefined);

// The target relays what the runtime asks of it.
const { target } = stub;
const objectId = innerDoIdFromName('x');
assert.equal(await target.hello(1, 2), 'called hello(1,2)');
assert.equal(await target.value, 'read value');
const walk = (holder, names) => names.reduce((at, name) => Object.getOwnPropertyDescriptor(at, name).value, holder);
assert.equal(await walk(target, ['obj', 'nested', 'y']), 'read obj.nested.y', 'a path is walked through own properties');
assert.equal(await walk(target, ['obj', 'f'])(), 'called obj.f()');
assert.equal(typeof target.value, 'function', 'a member is callable as well as thenable');
assert.deepEqual(calls, [
  ['callOn', objectId, ['hello'], [1, 2]],
  ['getOn', objectId, ['value']],
  ['getOn', objectId, ['obj', 'nested', 'y']],
  ['callOn', objectId, ['obj', 'f'], []],
], 'each access is one call on the binding, nothing else');

// The class check.
assert.deepEqual(new NimbusDurableObjectClasses({}, env).missing(['P', 'notAClass', 'Absent']), ['notAClass', 'Absent']);

// The modules.
const bundle = '// src/index.js\nexport class P {}\nexport default {};\n';
const { mainModule, modules, classesEntrypoint } = innerWorkerModules(bundle, ['P']);
assert.equal(mainModule, 'worker.js');
assert.equal(classesEntrypoint, 'NimbusDurableObjectClasses');
assert.deepEqual(Object.keys(modules), ['worker.js', 'nimbus-do-env.js']);
assert.equal(modules['worker.js'], "export { NimbusDurableObjectClasses as NimbusDurableObjectClasses } from './nimbus-do-env.js';" + bundle,
  'the adapter is the first import, on the first line');
assert.match(modules['nimbus-do-env.js'], /^import \{ env, RpcStub, WorkerEntrypoint \} from 'cloudflare:workers';\nimport \* as main from '\.\/worker\.js';/);
assert.match(modules['nimbus-do-env.js'], /, \["P"\], main, \{ env, RpcStub, WorkerEntrypoint \}\);\nexport \{ NimbusDurableObjectClasses \};$/);
assert.equal(innerWorkerModules('#!/usr/bin/env node\nexport default {};', ['P']).modules['worker.js'],
  "#!/usr/bin/env node\nexport { NimbusDurableObjectClasses as NimbusDurableObjectClasses } from './nimbus-do-env.js';export default {};",
  'a hashbang stays first');
assert.deepEqual(innerWorkerModules(bundle, []), { mainModule: 'worker.js', modules: { 'worker.js': bundle }, classesEntrypoint: null });

// A bundle that spells the class check's name (it exports it, say) gets one it never spells.
const exporting = 'class NimbusDurableObjectClasses {}\nconst NimbusDurableObjectClasses_2 = 1;\nexport { NimbusDurableObjectClasses, NimbusDurableObjectClasses_2 };\n';
const renamed = innerWorkerModules(exporting, ['P']);
assert.equal(renamed.classesEntrypoint, 'NimbusDurableObjectClasses_3');
assert.equal(renamed.modules['worker.js'], "export { NimbusDurableObjectClasses as NimbusDurableObjectClasses_3 } from './nimbus-do-env.js';" + exporting);

console.log('inner-do-env: a Durable Object binding is a local namespace whose stubs relay to the binding');
