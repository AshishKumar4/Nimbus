// One retained-heap measurement (interpreter-memory.mjs), run as
// `node --expose-gc memory-child.mjs <mode> <capture dir> <interpreter> <ops>`
// with cwd at the app whose code was captured. Prints one JSON line.
//
//   native-functions       the captured functions built by V8's constructors and held
//   interpreted-functions  the interpreter loaded, then the same functions built by it and held
//   native-config          the captured config module imported natively and held
//   interpreted-config     the interpreter loaded, then the config run as its module cell and held
//
// Each figure is V8's used heap after full collections, before and after; for
// the config, what it imports is loaded first, so only the module itself counts.

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';

const [, , mode, captureDir, interpreterFile, opsFile] = process.argv;
const require = createRequire(import.meta.url);
const used = () => {
  globalThis.gc();
  globalThis.gc();
  return getHeapStatistics().used_heap_size;
};
const read = (sub) => readdirSync(join(captureDir, sub)).sort().map((f) => JSON.parse(readFileSync(join(captureDir, sub, f), 'utf8')));
const held = [];
const result = { mode };

function loadInterpreter() {
  const before = used();
  const { createInterpreter } = require(interpreterFile);
  const interp = createInterpreter(require(opsFile), { dynamicImport: (parent, specifier) => import(String(specifier)) });
  // A first function and module warm the interpreter's own code; that is part of loading it.
  interp.compileFunction('function', ['a'], 'return a + 1')(1);
  const warm = { exports: {} };
  interp.compileModule('/warm.mjs', 'import { a } from "w"; export const b = () => a; export default class {}')(warm.exports, () => ({ a: 1 }), warm, '/warm.mjs', '/');
  result.interpreterLoad = used() - before;
  return interp;
}

if (mode.endsWith('functions')) {
  const functions = read('functions');
  result.functions = functions.length;
  result.sourceBytes = functions.reduce((n, f) => n + f.body.length, 0);
  if (mode === 'native-functions') {
    const constructors = {
      function: Function,
      async: Object.getPrototypeOf(async function () {}).constructor,
      generator: Object.getPrototypeOf(function* () {}).constructor,
      asyncGenerator: Object.getPrototypeOf(async function* () {}).constructor,
    };
    const before = used();
    for (const { kind, params, body } of functions) held.push(new constructors[kind](...params, body));
    result.retained = used() - before;
  } else {
    const interp = loadInterpreter();
    const before = used();
    for (const { kind, params, body } of functions) held.push(interp.compileFunction(kind, params, body));
    result.retained = used() - before;
  }
} else {
  const [config] = read('modules');
  const acorn = createRequire(fileURLToPath(new URL('../../../packages/core/package.json', import.meta.url)))('acorn');
  const specifiers = acorn.parse(config.text, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .filter((s) => s.type === 'ImportDeclaration').map((s) => s.source.value);
  const appRequire = createRequire(join(process.cwd(), 'package.json'));
  for (const specifier of specifiers) {
    // Vite writes resolved file: URLs into the bundled config.
    const direct = specifier.startsWith('node:') || specifier.startsWith('file:');
    held.push(await import(direct ? specifier : pathToFileURL(appRequire.resolve(specifier)).href));
  }
  const interp = mode === 'interpreted-config' ? loadInterpreter() : null;
  const file = join(process.cwd(), 'node_modules/.vite-temp', `memory-${process.pid}.mjs`);
  writeFileSync(file, config.text);
  try {
    const before = used();
    if (interp === null) {
      held.push(await import(pathToFileURL(file).href));
    } else {
      const fileRequire = createRequire(file);
      const module = { exports: {}, __nimbusImportMeta: { url: pathToFileURL(file).href, dirname: dirname(file), filename: file } };
      await interp.compileModule(file, config.text)(module.exports, (id) => fileRequire(id.startsWith('file:') ? fileURLToPath(id) : id), module, file, dirname(file));
      held.push(module.exports);
    }
    result.retained = used() - before;
  } finally {
    rmSync(file, { force: true });
  }
}
console.log(JSON.stringify(result));
