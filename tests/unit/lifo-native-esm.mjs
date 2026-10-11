#!/usr/bin/env bun
// The lifo node links and evaluates ES modules in its own engine. The same
// VFS programs run under host Node 22, under a Bun-hosted workspace, then
// under a Node-hosted workspace against dist, as inline-node-realm.mjs does.
// A lowering cannot keep a named import live, reproduce a cyclic TDZ and
// native microtask order, or give require(esm) Node's two graph errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');
const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim();
assert.match(nodeVersion ?? '', /^v22\./, 'the native-ESM differential needs host Node 22');
const directory = mkdtempSync(join(tmpdir(), 'lifo-native-esm-'));
const vfsDirectory = '/home/user/native-esm';

const files = {
  'package.json': JSON.stringify({ name: 'lifo-esm-test', imports: { '#pick': { import: './import.mjs', require: './require.cjs' } } }),
  'import.mjs': 'export default "import-condition";\n',
  'require.cjs': 'module.exports = "require-condition";\n',
  'node_modules/condition/package.json': JSON.stringify({ name: 'condition', exports: { '.': { import: './import.mjs', require: './require.cjs' } } }),
  'node_modules/condition/import.mjs': 'export default "package-import";\n',
  'node_modules/condition/require.cjs': 'module.exports = "package-require";\n',
  'counter.mjs': 'export let n = 1; export function inc() { n++; } export default "counter";\n',
  'cjs.cjs': 'exports.value = 42; exports["odd-name"] = 7; if (false) exports.missing = 1;\n',
  'meta.mjs': 'export const meta = import.meta; export const scope = [typeof require, typeof __filename, typeof __dirname].join(",");\n',
  'data.json': '{"value":23}\n',
  'tla.mjs': 'globalThis.events.push("tla-start"); await Promise.resolve(); globalThis.events.push("tla-end"); export const ready = true;\n',
  'syntax.js': 'console.log("detected", typeof import.meta.url);\n',
  'cycle/a.mjs': 'import { b } from "./b.mjs"; import "./c.mjs"; export let a = 1; export const read = () => b; events.push("a"); queueMicrotask(() => events.push("a-micro"));\n',
  'cycle/b.mjs': 'import { a } from "./a.mjs"; import "./d.mjs"; export const b = 2; try { events.push(a); } catch (e) { events.push(e.name); } events.push("b"); queueMicrotask(() => events.push("b-micro"));\n',
  'cycle/c.mjs': 'import "./d.mjs"; import "./e.mjs"; events.push("c"); queueMicrotask(() => events.push("c-micro"));\n',
  'cycle/d.mjs': 'import "./f.mjs"; events.push("d"); queueMicrotask(() => events.push("d-micro"));\n',
  'cycle/e.mjs': 'import "./b.mjs"; events.push("e"); queueMicrotask(() => events.push("e-micro"));\n',
  'cycle/f.mjs': 'import "./a.mjs"; events.push("f"); queueMicrotask(() => events.push("f-micro"));\n',
  'cycle/main.mjs': 'import { a, read } from "./a.mjs"; events.push("cycle:" + a + ":" + read());\n',
  'missing-export.mjs': 'import { absent } from "./counter.mjs"; console.log(absent);\n',
  'extension.js': 'export default 1;\n',
  'spaced #?.mjs': 'export const url = import.meta.url; export const filename = import.meta.filename;\n',
  'dir/index.js': 'export default 1;\n',
  'main.mjs': [
    'import def, { n, inc } from "./counter.mjs";',
    'import cjs, { value, missing, "odd-name" as odd } from "./cjs.cjs";',
    'import fs, { readFileSync } from "node:fs";',
    'import path, { basename } from "path";',
    'import { createRequire } from "node:module";',
    'import { fileURLToPath } from "node:url";',
    'import { meta, scope } from "./meta.mjs";',
    'import picked from "#pick";',
    'import condition from "condition";',
    'const require = createRequire(import.meta.url);',
    'inc(); console.log("live", n, def);',
    'console.log("scope", scope, typeof __filename, typeof __dirname);',
    'console.log("cjs", value, odd, missing, cjs === require("./cjs.cjs"));',
    'console.log("builtins", readFileSync === fs.readFileSync, basename === path.basename, path === require("node:path"), JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).name);',
    'console.log("conditions", picked, condition, require("#pick"), require("condition"));',
    'console.log("meta", import.meta.main, meta.main, import.meta.filename === fileURLToPath(import.meta.url), import.meta.dirname + "/main.mjs" === import.meta.filename, Object.keys(import.meta).join(","), typeof import.meta.resolve, import.meta.resolve("node:fs"), import.meta.resolve("#pick").endsWith("/import.mjs"), Object.getPrototypeOf(import.meta) === null);',
    'globalThis.events = [];',
    'await import("./cycle/main.mjs");',
    'console.log("cycle", JSON.stringify(events));',
    'events = []; const tla = await import("./tla.mjs"); console.log("tla", tla.ready, JSON.stringify(events));',
    'const cjsNamespace = await import("./cjs.cjs");',
    'console.log("namespace", Object.keys(cjsNamespace).join(","), Object.prototype.toString.call(cjsNamespace), cjsNamespace.default === cjs, cjsNamespace === await import("./cjs.cjs"), (await import("node:path")) === await import("path"));',
    'let threw = false; const pending = (() => { try { return import("./absent.mjs"); } catch { threw = true; } })();',
    'await pending.catch((e) => console.log("dynamic-miss", threw, e.code));',
    'for (const specifier of ["./extension", "./dir"]) { try { await import(specifier); } catch (e) { console.log("resolution", specifier, e.code); } }',
    'try { await import("./missing-export.mjs"); } catch (e) { console.log("missing-export", e.name, e.message); }',
    'const one = await import("./counter.mjs?one"), two = await import("./counter.mjs?two");',
    'one.inc(); console.log("queries", one === two, one.n, two.n);',
    'const spaced = await import("./spaced%20%23%3F.mjs"); console.log("encoded", spaced.filename.endsWith("/spaced #?.mjs"), spaced.url.endsWith("/spaced%20%23%3F.mjs"), fileURLToPath(spaced.url) === spaced.filename);',
    'const json = await import("./data.json", { with: { type: "json" } }); console.log("json", json.default.value, json.default === require("./data.json"));',
    'try { await import("./data.json"); } catch (e) { console.log("json-attributes", e.code); }',
    '',
  ].join('\n'),
  'sync.mjs': 'export let n = 1; export const inc = () => n++; export default 8;\n',
  'no-default.mjs': 'export const value = 5;\n',
  'own-marker.mjs': 'export const __esModule = false; export default 6;\n',
  'module-exports.mjs': 'const result = { marker: 12 }; export { result as "module.exports" }; export default 13;\n',
  'async-required.mjs': 'console.log("never-async-body"); await Promise.resolve(); export const value = 3;\n',
  'async-parent.mjs': 'import "./async-required.mjs"; console.log("never-parent-body"); export const value = 4;\n',
  'async-loop.mjs': 'console.log("never-loop-body"); for await (const value of []) {} export default 1;\n',
  'inside-function.mjs': 'export async function work() { await 0; } export default 2;\n',
  'required-cycle.mjs': 'import "./required-cycle.cjs"; export const value = 7;\n',
  'required-cycle.cjs': 'require("./required-cycle.mjs");\n',
  'require-main.cjs': [
    'const ns = require("./sync.mjs"); ns.inc();',
    'console.log("required", Object.keys(ns).join(","), ns.default, ns.n, ns.__esModule, Object.getPrototypeOf(ns) === null, Object.prototype.toString.call(ns), ns === require("./sync.mjs"));',
    'console.log("no-default", Object.keys(require("./no-default.mjs")).join(","), require("./no-default.mjs").value);',
    'console.log("own-marker", require("./own-marker.mjs").__esModule);',
    'console.log("module-exports", require("./module-exports.mjs").marker);',
    'console.log("function-await", require("./inside-function.mjs").default);',
    'for (const file of ["./async-required.mjs", "./async-parent.mjs", "./async-loop.mjs", "./required-cycle.mjs"]) { try { require(file); } catch (e) { console.log("require-error", file, e.code, e.message); } }',
    'import("./sync.mjs").then((m) => console.log("cjs-dynamic", m.n, m.inc === ns.inc));',
    '',
  ].join('\n'),
};

const { sql, transactions } = await hostSqlite();
const workspace = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const normalize = (text) => text.split(directory).join('<project>').split(vfsDirectory).join('<project>');
try {
  for (const [name, source] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    await workspace.fs.mkdir(dirname(`${vfsDirectory}/${name}`), { recursive: true });
    await workspace.fs.writeFile(`${vfsDirectory}/${name}`, source);
  }
  for (const entry of ['main.mjs', 'require-main.cjs', 'syntax.js']) {
    const reference = spawnSync('node', ['--no-warnings', entry], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    assert.equal(reference.status, 0, `${entry} reference: ${reference.stderr}`);
    assert.equal(reference.stderr, '', `${entry} reference stderr`);
    const ours = await workspace.exec(`node ${entry}`, { cwd: vfsDirectory });
    assert.equal(ours.exitCode, reference.status, `${entry}: ${ours.stderr}`);
    assert.equal(ours.stderr, '', `${entry}: ${ours.stderr}`);
    assert.equal(normalize(ours.stdout), normalize(reference.stdout), `${entry} under ${underBun ? 'Bun' : 'Node'} matches Node ${nodeVersion}`);
  }
  const main = await workspace.exec('node main.mjs', { cwd: vfsDirectory });
  assert.match(main.stdout, /live 2 counter\n/);
  assert.match(main.stdout, /meta true false true true dirname,filename,main,resolve,url function node:fs true true\n/);
  assert.match(main.stdout, /cycle \["f","d","ReferenceError","b","e","c","a","cycle:1:2","f-micro","d-micro","b-micro","e-micro","c-micro","a-micro"\]\n/);
  assert.match(main.stdout, /The requested module '\.\/counter\.mjs' does not provide an export named 'absent'/);
  const required = await workspace.exec('node require-main.cjs', { cwd: vfsDirectory });
  assert.doesNotMatch(required.stdout, /never-/);
  assert.match(required.stdout, /ERR_REQUIRE_ASYNC_MODULE/);
  assert.match(required.stdout, /ERR_REQUIRE_CYCLE_MODULE/);
} finally {
  await workspace.close();
  rmSync(directory, { recursive: true, force: true });
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(node.status, 0, `Node-hosted workspace:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - lifo-native-esm under Node/m);
  console.log(`ok - lifo-native-esm (Bun and Node workspaces match Node ${nodeVersion})`);
} else console.log(`ok - lifo-native-esm under Node ${nodeVersion}`);
