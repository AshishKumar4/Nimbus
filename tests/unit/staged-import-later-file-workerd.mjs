// @serial
// @tier slow — drives a local workerd
// A module staged with the launch statically imports a file the program
// writes after the launch began: the import finds it, as Node's does, and
// one still missing fails as Node's (ticket-staged-import-of-later-file).
//   - m0 imports ./m1.mjs, written before m0 is imported;
//   - m3 imports ./m4.mjs?x, a query of a file written later;
//   - m2 imports ./absent.mjs, never written: Node's ERR_MODULE_NOT_FOUND;
//   - parent imports bridge, which imports ./generated.json (type json),
//     written later: a JSON module, not read as JavaScript;
//   - qparent imports qbridge, which imports ./generated.json?x and #x
//     (type json): a query's and a fragment's JSON module;
//   - m5 imported before ./late.mjs is written, then after: both imports
//     fail, as Node's loader keeps the module job that did not link;
//   - outer, written later, imports b5, which imports ./late5.mjs: imported
//     before ./late5.mjs is written, then after, outer fails still, and so
//     does b5 imported alone or from outer2, a module written since;
//   - outer6 imports c, which imports ./late6.mjs, all written later: c
//     fails still once ./late6.mjs is written, and outer6's require() too;
//   - r, required before ./late7.mjs is written, then after: require()
//     keeps no failure, as Node's does not, and a later import() finds it;
//   - outer8, written later, imports bin, whose require() of app (which
//     imports ./late8.mjs) staging hoisted: once ./late8.mjs is written,
//     app imported alone loads (a require()'s failure is not kept), outer8
//     and bin fail still;
//   - outer9 imports bin9 (a hoisted require() of app9), then app9 itself,
//     which imports ./late9.mjs: app9's static import is linked first, its
//     failure kept, so app9, outer9 and bin9 fail once ./late9.mjs is
//     written;
//   - bin10 requires mid10, which requires app10, which imports
//     ./late10.mjs, both require()s hoisted: once ./late10.mjs is written,
//     bin10 and mid10 fail still (each evaluation threw), app10 loads;
//   - outer11, written later, imports bin11 → (hoisted) mid11 → (hoisted)
//     app11 → ./late11.mjs: once ./late11.mjs is written, outer11, bin11
//     and mid11 fail still, app11 loads;
//   - bin12 imports writer12, which writes ./late12.mjs, then requires
//     app12 (hoisted), which imports it: the require() finds it, as it
//     runs after writer12 evaluates.
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
  'parent.mjs': "import { v } from './bridge.mjs';\nexport const p = v;\n",
  'bridge.mjs': "import data from './generated.json' with { type: 'json' };\nexport const v = data.v;\n",
  'm5.mjs': "import { v as w } from './late.mjs';\nexport const v = w;\n",
  'qparent.mjs': "import { v } from './qbridge.mjs';\nexport const p = v;\n",
  'qbridge.mjs': "import a from './generated.json?x' with { type: 'json' };\nimport b from './generated.json#x' with { type: 'json' };\nexport const v = a.v + b.v;\n",
  'b5.mjs': "import { v as w } from './late5.mjs';\nexport const v = w;\n",
  'bin.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./app.mjs');\nexport const b = 'bin';\n",
  'app.mjs': "import { v } from './late8.mjs';\nexport const a = v;\n",
  'bin9.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./app9.mjs');\nexport const b = 'bin9';\n",
  'app9.mjs': "import { v } from './late9.mjs';\nexport const a = v;\n",
  'bin10.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./mid10.mjs');\nexport const b = 'bin10';\n",
  'mid10.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./app10.mjs');\nexport const m = 'mid10';\n",
  'app10.mjs': "import { v } from './late10.mjs';\nexport const a = v;\n",
  'bin11.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./mid11.mjs');\nexport const b = 'bin11';\n",
  'mid11.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./app11.mjs');\nexport const m = 'mid11';\n",
  'app11.mjs': "import { v } from './late11.mjs';\nexport const a = v;\n",
  'bin12.mjs': "import './writer12.mjs';\nimport { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./app12.mjs');\nexport const b = 'bin12';\n",
  'writer12.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./late12.mjs', import.meta.url), 'export const v = 12;\\n');\n",
  'app12.mjs': "import { v } from './late12.mjs';\nexport const a = v;\n",
  // Each names its staged module in a branch never taken, so the launch stages it.
  'main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "if (globalThis.never) { await import('./m0.mjs'); await import('./m2.mjs'); await import('./m3.mjs'); await import('./parent.mjs'); await import('./m5.mjs'); await import('./qparent.mjs'); await import('./b5.mjs'); await import('./bin.mjs'); await import('./bin9.mjs'); await import('./bin10.mjs'); await import('./bin11.mjs'); await import('./bin12.mjs'); }",
    write('./m1.mjs', "export const v = 'm1';\n"),
    write('./m4.mjs', "export const v = 'm4';\n"),
    "console.log((await import('./m0.mjs')).v);",
    "console.log((await import('./m3.mjs')).v);",
    "try { await import('./m2.mjs'); } catch (error) { console.log(error.code, error.message); }",
    write('./generated.json', '{"v":1}'),
    "console.log((await import('./parent.mjs')).p);",
    "console.log((await import('./qparent.mjs')).p);",
    "try { await import('./m5.mjs'); } catch (error) { console.log('first', error.code); }",
    write('./late.mjs', 'export const v = 5;\n'),
    "try { console.log('second', (await import('./m5.mjs')).v); } catch (error) { console.log('second', error.code); }",
    write('./outer.mjs', "import { v } from './b5.mjs';\nexport const o = v;\n"),
    "try { await import('./outer.mjs'); } catch (error) { console.log('outer first', error.code); }",
    write('./late5.mjs', 'export const v = 5;\n'),
    "try { console.log('outer second', (await import('./outer.mjs')).o); } catch (error) { console.log('outer second', error.code); }",
    "try { console.log('b5', (await import('./b5.mjs')).v); } catch (error) { console.log('b5', error.code); }",
    write('./outer2.mjs', "import { v } from './b5.mjs';\nexport const o = v;\n"),
    "try { console.log('outer2', (await import('./outer2.mjs')).o); } catch (error) { console.log('outer2', error.code); }",
    write('./c.mjs', "import { v } from './late6.mjs';\nexport const c = v;\n"),
    write('./outer6.mjs', "import { c } from './c.mjs';\nexport const o = c;\n"),
    "try { await import('./outer6.mjs'); } catch (error) { console.log('outer6', error.code); }",
    write('./late6.mjs', 'export const v = 6;\n'),
    "try { console.log('c', (await import('./c.mjs')).c); } catch (error) { console.log('c', error.code); }",
    "try { console.log('require outer6', require('./outer6.mjs').o); } catch (error) { console.log('require outer6', error.code); }",
    write('./r.mjs', "import { v } from './late7.mjs';\nexport const r = v;\n"),
    "try { require('./r.mjs'); } catch (error) { console.log('require r', error.code); }",
    write('./late7.mjs', 'export const v = 7;\n'),
    "try { console.log('require r', require('./r.mjs').r); } catch (error) { console.log('require r', error.code); }",
    "try { console.log('import r', (await import('./r.mjs')).r); } catch (error) { console.log('import r', error.code); }",
    write('./outer8.mjs', "import { b } from './bin.mjs';\nexport const o = b;\n"),
    "try { await import('./outer8.mjs'); } catch (error) { console.log('outer8 first', error.code); }",
    write('./late8.mjs', 'export const v = 8;\n'),
    "try { console.log('app', (await import('./app.mjs')).a); } catch (error) { console.log('app', error.code); }",
    "try { console.log('outer8 second', (await import('./outer8.mjs')).o); } catch (error) { console.log('outer8 second', error.code); }",
    "try { console.log('bin', (await import('./bin.mjs')).b); } catch (error) { console.log('bin', error.code); }",
    write('./outer9.mjs', "import { b } from './bin9.mjs';\nimport { a } from './app9.mjs';\nexport const o = b + a;\n"),
    "try { await import('./outer9.mjs'); } catch (error) { console.log('outer9 first', error.code); }",
    write('./late9.mjs', 'export const v = 9;\n'),
    "try { console.log('app9', (await import('./app9.mjs')).a); } catch (error) { console.log('app9', error.code); }",
    "try { console.log('outer9 second', (await import('./outer9.mjs')).o); } catch (error) { console.log('outer9 second', error.code); }",
    "try { console.log('bin9', (await import('./bin9.mjs')).b); } catch (error) { console.log('bin9', error.code); }",
    "try { await import('./bin10.mjs'); } catch (error) { console.log('bin10 first', error.code); }",
    write('./late10.mjs', 'export const v = 10;\n'),
    "try { console.log('bin10 second', (await import('./bin10.mjs')).b); } catch (error) { console.log('bin10 second', error.code); }",
    "try { console.log('mid10', (await import('./mid10.mjs')).m); } catch (error) { console.log('mid10', error.code); }",
    "try { console.log('app10', (await import('./app10.mjs')).a); } catch (error) { console.log('app10', error.code); }",
    write('./outer11.mjs', "import { b } from './bin11.mjs';\nexport const o = b;\n"),
    "try { await import('./outer11.mjs'); } catch (error) { console.log('outer11 first', error.code); }",
    write('./late11.mjs', 'export const v = 11;\n'),
    "for (const name of ['outer11', 'bin11', 'mid11', 'app11']) try { const m = await import(`./${name}.mjs`); console.log(name, m.o ?? m.b ?? m.m ?? m.a); } catch (error) { console.log(name, error.code); }",
    "for (const name of ['bin12', 'app12']) try { const m = await import(`./${name}.mjs`); console.log(name, m.b ?? m.a); } catch (error) { console.log(name, error.code); }",
    '',
  ].join('\n'),
};

await matchNodeInWorkerd('staged-import-later-file', ROOT, files, ['node main.mjs']);
console.log('ok - staged-import-later-file-workerd');
