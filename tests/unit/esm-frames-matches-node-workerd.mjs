// @serial
// @tier slow — drives a local workerd
// Stack frames and the fatal report's arrow, for ES modules small and large
// (each staged for the registry: core runtime/native-esm.ts) and for
// CommonJS: an ES module's frame names its file: URL, a CommonJS module's its
// path, top-level code reads Node's way (`Object.<anonymous>`, or nothing in
// an ES module), and the line and column are the file's, past what staging
// adds on the first line, past a rewritten specifier, and past import.meta's
// binding; a program's own Error.prepareStackTrace is handed call sites so
// named.
// stdout and stderr are host Node's, with the program's frames kept and
// Node's own left out.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const W = '/home/user/frames';
const FILES = {
  'top.mjs': "const a = 1;\nthrow new Error('top ' + a);\n",
  'fn.mjs': "import { sep } from 'node:path';\nexport function fail(n) {\n  throw new RangeError('fn ' + n + sep);\n}\nfail(1);\n",
  'reject.mjs': "console.log('before');\nPromise.reject(new Error('rejected'));\n",
  'tla.mjs': "const v = await Promise.resolve(2);\nthrow new TypeError('after await ' + v);\n",
  'meta.mjs': "const u = import.meta.url;\nconst d = 2;\nthrow new Error('after meta ' + d + typeof u);\n",
  'line1.mjs': "import { sep } from 'node:path'; const s = 1; throw new Error('line one ' + s);\n",
  'big.mjs': `export function deep() {\n  throw new Error('big');\n}\nconst pad = "${'x'.repeat(600_000)}";\ndeep(pad);\n`,
  'cjs.cjs': "const a = 1;\nfunction f() { throw new Error('cjs ' + a); }\nf();\n",
  // Columns after what staging rewrites on a line: a specifier, import.meta, an anonymous default's head.
  'sameline.mjs': "import { sep, join } from 'node:path'; const u = import.meta.url; const s = join('a', 'b') + sep; throw new Error('same line ' + s.length + typeof u);\n",
  'anon.mjs': "export default function () { throw new Error('anonymous default'); }\n",
  // An edit's length after every normalization (typeof of an unbound name), import.meta spelled with spaces.
  'typeofs.mjs': "import { sep } from 'node:path'; const t = typeof require + typeof module; throw new Error('typeofs ' + t + sep);\n",
  'spaced.mjs': "const u = import . meta . url; throw new Error('spaced ' + typeof u);\n",
  // Text the emit carries that looks like what it generates: an export name, an escaped identifier.
  'names.mjs': "import { sep } from 'node:path';\nconst value = 1; export { value as \"/*nimbus-columns \" };\nconst \\u005f_nimbus_m0 = 42, \\u005f_nimbus_m1 = 43;\nconsole.log(sep, __nimbus_m0 + __nimbus_m1, new Error('names').stack.split('\\n')[1].trim());\n",
  'callanon.mjs': "import run from './anon.mjs'; import { sep } from 'node:path'\nconst x = sep\nrun()\n",
  // Node shows the line it compiled, not what the file holds when it throws.
  'overwrite.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL(import.meta.url), 'replaced\\nreplaced\\nreplaced\\n');\nthrow new Error('overwritten');\n",
  'lib.mjs': "export function make() { return new Error('lib'); }\nexport function fail() {\n  null.x;\n}\n",
  'caught.mjs': [
    "import * as lib from './lib.mjs';",
    "const frame = (e) => e.stack.split('\\n').slice(1, 3).map((line) => line.trim()).join(' | ');",
    "class C { m() { return new Error('method'); } }",
    'console.log(frame(new C().m()));',
    "const arrow = () => new Error('arrow');",
    'console.log(frame(arrow()));',
    'console.log(frame(lib.make()));',
    'try { lib.fail(); } catch (e) { console.log(frame(e)); }',
    "export default class Thing { static make() { return new Error('default'); } }",
    'console.log(frame(Thing.make()));',
    "console.log(new Error('top').stack.split('\\n')[1].trim());",
  ].join('\n') + '\n',
  'prepare.mjs': [
    "Error.prepareStackTrace = function () { return this === Error; };",
    "console.log(new Error('receiver').stack);",
    "function hook() { return 'wanted'; }",
    "hook.call = () => 'wrong';",
    "Error.prepareStackTrace = hook;",
    "console.log(new Error('applied').stack);",
    "Error.prepareStackTrace = (error, sites) => sites.slice(0, 1).map((site) => [site.getFileName(), site.getLineNumber(), site.getColumnNumber(), site.getFunctionName()].join(' ')).join();",
    "function named() { return new Error('third'); }",
    'console.log(named().stack);',
    'Error.prepareStackTrace = undefined;',
    "console.log(new Error('fourth').stack.split('\\n')[1].trim());",
  ].join('\n') + '\n',
};
const COMMANDS = [
  'node top.mjs', 'node fn.mjs', 'node reject.mjs', 'node tla.mjs', 'node meta.mjs', 'node line1.mjs', 'node big.mjs',
  'node cjs.cjs', 'node caught.mjs', 'node prepare.mjs', `node --input-type=module -e "const x = 1; throw new Error('eval ' + x);"`,
  'node sameline.mjs', 'node callanon.mjs', 'node overwrite.mjs', 'node typeofs.mjs', 'node spaced.mjs', 'node names.mjs', `node --input-type=module -e "process.chdir('/'); throw new Error('moved');"`,
];

await matchNodeInWorkerd('esm-frames-matches-node-workerd', W, FILES, COMMANDS);
console.log(`esm-frames-matches-node-workerd: ${COMMANDS.length} programs' frames and arrows as Node's`);
