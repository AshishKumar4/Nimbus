// @serial
// @tier slow — drives a local workerd
// `node -e`, `node -p` and a program read from stdin, as Node 22 takes
// their TypeScript (lib/internal/main/eval_string.js, eval_stdin.js,
// lib/internal/process/execution.js): with type stripping on (the default)
// and no `--input-type`, code that does not compile as JavaScript is
// stripped and run (an ES module by its syntax once stripped), and code
// TypeScript cannot read either fails with V8's error, amaro's message
// beside its arrow; `--input-type=commonjs-typescript` and
// `module-typescript` strip first; `--no-experimental-strip-types` takes
// none of it; `--input-type` of another value is refused. Generated: each
// source below under each way of giving it and each flag set that tells
// something of it. Host Node is the oracle.
import { matchNodeInWorkerd, shellWord } from './lib/node-differential.mjs';

/** Eval sources, by what they are. */
const SOURCES = {
  js: 'console.log(1 + 1)',
  ts: 'const a: number = 2; console.log(a)',
  typeOnly: 'type T = number; const a: T = 4; console.log(a)',
  invalid: 'const x = ;',
  open: 'console.log(1',
  enum: 'enum E { A = 7 } console.log(E.A)',
  esmJs: "import { sep } from 'node:path'; console.log(sep)",
  esmTs: "import { sep } from 'node:path'; const s: string = sep; console.log(s)",
  esmInvalid: "import { sep } from 'node:path'; const x = ;",
  throws: "const a: number = 1; throw new Error('thrown ' + a)",
  frame: "const a: number = 1; console.log(new Error('here').stack.split('\\n')[1])",
  crypto: 'const c: any = crypto; console.log(typeof c.createHash)',
  topAwait: 'const a: number = await Promise.resolve(5); console.log(a)',
  esmThrows: "import { sep } from 'node:path'; const s: string = sep; throw new Error('thrown ' + s)",
  // Node's -e wraps code naming `crypto` before it detects module syntax, so this is no module it can compile.
  cryptoEsm: "import { sep } from 'node:path'; console.log(typeof crypto, sep)",
  // An import or export nested in a statement is module syntax to Node's detection, which fails as a module.
  nestedImport: "{ import { sep } from 'node:path'; }",
  nestedImportDefault: "if (globalThis.x) import x from 'node:path';",
  nestedExport: 'function f() { export const a = 1; }',
};
/** Sources `-p` prints the value of. */
const PRINTED = {
  js: '1 + 2',
  ts: 'const a: number = 3; a',
  invalid: 'const x = ;',
  esmTs: "import { sep } from 'node:path'; const s: string = sep; s",
};
/** Flag sets, and the sources each is run with (all of them where none are named). */
const FLAGS = [
  { flags: '' },
  { flags: '--no-experimental-strip-types', sources: ['ts', 'invalid', 'enum', 'esmTs', 'esmInvalid', 'nestedImport', 'nestedExport'] },
  { flags: '--input-type=commonjs', sources: ['ts', 'invalid', 'esmJs', 'esmTs'] },
  { flags: '--input-type=module', sources: ['ts', 'invalid', 'js', 'esmTs'] },
  { flags: '--input-type=commonjs-typescript', sources: ['js', 'ts', 'invalid', 'enum', 'esmTs', 'throws'] },
  { flags: '--input-type=module-typescript', sources: ['js', 'ts', 'invalid', 'enum', 'esmTs', 'topAwait'] },
  { flags: '--no-experimental-strip-types --input-type=commonjs-typescript', sources: ['ts', 'js'] },
  { flags: '--no-experimental-strip-types --input-type=module-typescript', sources: ['ts', 'js'] },
  { flags: '--experimental-transform-types', sources: ['enum', 'ts', 'invalid'] },
  { flags: '--input-type=typescript', sources: ['js'] },
];
const PRINT_FLAGS = ['', '--input-type=commonjs-typescript', '--input-type=module-typescript', '--no-experimental-strip-types'];

const node = (flags) => (flags ? `node ${flags}` : 'node');
const commands = [];
for (const { flags, sources } of FLAGS) {
  for (const name of sources ?? Object.keys(SOURCES)) {
    const source = SOURCES[name];
    commands.push(`${node(flags)} -e ${shellWord(source)}`);
    // stdin once for each flag set's sources where the flags say how to take it.
    if (flags === '' || flags.includes('typescript')) commands.push(`printf '%s' ${shellWord(source)} | ${node(flags)}`);
  }
}
for (const flags of PRINT_FLAGS) {
  for (const source of Object.values(PRINTED)) commands.push(`${node(flags)} -p ${shellWord(source)}`);
}
// Code Node's eval compiles first, it refuses before `--import`'s modules load; code it strips, after.
for (const name of ['invalid', 'ts']) commands.push(`node --import ./nope.mjs -e ${shellWord(SOURCES[name])}`);

await matchNodeInWorkerd('eval-typescript', '/home/user/evalts', { 'package.json': '{}\n' }, commands);
console.log(`ok - eval-typescript-matches-node-workerd (${commands.length} programs, as host Node runs them)`);
