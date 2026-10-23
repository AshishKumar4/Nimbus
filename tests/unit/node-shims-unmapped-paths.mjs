// The synchronous filesystem view is the whole filesystem the credential can
// see, never a walk of selected roots.
//
// It used to be partial: __vfsManifest was a walk of the working directory,
// its node_modules and the entry script's own package, and every synchronous
// call treated it as total. A path the walk never reached was answered as
// though it had been looked for and not found:
//
//     readdirSync(dir)                    → []          (a populated directory)
//     existsSync(dir + '/meta.json')      → false
//     statSync(dir)                       → ENOENT
//
// while fs.promises.readdir on the same path returned the real entries: one
// process, two filesystems. A scaffolder read its template directory, was told
// it was empty, wrote nothing, and exited 0; create-next-app died on EAGAIN
// for a config file under $HOME/.config that had never existed.
//
// The namespace (vfs/resident/index.ts, CUTOVER #13) is listed before
// user code runs, so there is no unmapped world. This pins the invariant from
// the first call: every answer is the authority's, sync and async alike, for
// a tree outside the working directory, under $HOME/.config, and for a path
// that is simply absent (plain ENOENT, which the config idiom depends on).

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const APP = '/home/user/example-app';
authority.kfs.mkdir(APP, { recursive: true });
authority.kfs.writeFile(`${APP}/entry.js`, 'module.exports = 1;\n');
// What no walk of the working directory reaches: a template cache, and a
// tool's config directory under $HOME.
const MINIMAL = '/tmp/cache/templates/minimal';
authority.kfs.mkdir(`${MINIMAL}/src`, { recursive: true });
authority.kfs.writeFile(`${MINIMAL}/meta.json`, '{"name":"minimal"}');
authority.kfs.writeFile(`${MINIMAL}/README.md`, '# minimal\n');
authority.kfs.writeFile(`${MINIMAL}/src/main.js`, 'export default 1;\n');
const CFG = '/home/user/.config';
authority.kfs.mkdir(`${CFG}/present-tool`, { recursive: true });
authority.kfs.writeFile(`${CFG}/present-tool/state.json`, '{"real":true}');

const { fs } = shimsOnSession({
  authority,
  cwd: APP,
  bundle: { 'home/user/example-app/entry.js': 'module.exports = 1;\n' },
});

// A tree outside the working directory: the same answers sync and async.
assert.deepEqual(fs.readdirSync(MINIMAL).sort(), ['README.md', 'meta.json', 'src'], 'a listing is the directory, never []');
assert.deepEqual((await fs.promises.readdir(MINIMAL)).sort(), fs.readdirSync(MINIMAL).sort(), 'one process sees one filesystem');
{
  const dirents = fs.readdirSync(MINIMAL, { withFileTypes: true });
  assert.equal(dirents.find((d) => d.name === 'src').isDirectory(), true, 'a subdirectory is a directory');
  assert.equal(dirents.find((d) => d.name === 'meta.json').isDirectory(), false, 'and a file a file');
}
assert.equal(fs.existsSync(`${MINIMAL}/meta.json`), true);
assert.equal(fs.statSync(MINIMAL).isDirectory(), true);
assert.deepEqual(fs.readdirSync(`${MINIMAL}/src`), ['main.js'], 'a nested directory answers from the first call');

// The config idiom: read a config, treat ENOENT as "none yet". Absence is
// plain ENOENT, never a refusal, under $HOME/.config as anywhere.
assert.throws(() => fs.readFileSync(`${CFG}/new-tool/config.json`, 'utf8'), (e) => e.code === 'ENOENT');
assert.throws(() => fs.readFileSync('/home/user/.absent-tool/config.json', 'utf8'), (e) => e.code === 'ENOENT');
assert.equal(fs.existsSync(`${APP}/nope.txt`), false);
assert.equal(fs.statSync(`${APP}/nope.txt`, { throwIfNoEntry: false }), undefined);
assert.equal(fs.existsSync(`${CFG}/present-tool/state.json`), true, 'a present config is there, sync');
assert.equal(await fs.promises.readFile(`${CFG}/present-tool/state.json`, 'utf8'), '{"real":true}');

// Nothing answered for a path that was there was ever an absence: no misses.
assert.deepEqual((await globalThis.__nimbusProcessFs.misses()).filter((k) => k.includes('templates') || k.includes('.config')), []);

process.stdout.write('node-shims-unmapped-paths: all tests passed\n');
