// @serial
// @tier slow — drives a local workerd
// A module staged with the launch statically imports a file the program
// writes after the launch began: the import finds it, as Node's does, and
// one still missing fails as Node's (ticket-staged-import-of-later-file).
//   - m0 imports ./m1.mjs, written before m0 is imported;
//   - m3 imports ./m4.mjs?x, a query of a file written later;
//   - m2 imports ./absent.mjs, never written: Node's ERR_MODULE_NOT_FOUND.
// Host Node running the same files is the oracle.
//
// Red before: staging recorded the missing file as a refusal, so m0's
// import failed with "Cannot find module" where Node found it.
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/later';
const write = (name, text) => `writeFileSync(new URL(${JSON.stringify(name)}, import.meta.url), ${JSON.stringify(text)});`;
const files = {
  'm0.mjs': "import { v as w } from './m1.mjs';\nexport const v = `m0+${w}`;\n",
  'm2.mjs': "import './absent.mjs';\nexport const v = 'm2';\n",
  'm3.mjs': "import { v as w } from './m4.mjs?x';\nexport const v = `m3+${w}`;\n",
  // Each names its staged module in a branch never taken, so the launch stages it.
  'main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) { await import('./m0.mjs'); await import('./m2.mjs'); await import('./m3.mjs'); }",
    write('./m1.mjs', "export const v = 'm1';\n"),
    write('./m4.mjs', "export const v = 'm4';\n"),
    "console.log((await import('./m0.mjs')).v);",
    "console.log((await import('./m3.mjs')).v);",
    "try { await import('./m2.mjs'); } catch (error) { console.log(error.code, error.message); }",
    '',
  ].join('\n'),
};

await matchNodeInWorkerd('staged-import-later-file', ROOT, files, ['node main.mjs']);
console.log('ok - staged-import-later-file-workerd');
