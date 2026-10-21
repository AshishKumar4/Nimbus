#!/usr/bin/env bun
// An `@source` path is never brace-expanded (Kinu ask 68): the plan takes
// where it can reach, linearly in its length (sourceReach), so a stylesheet
// an agent writes cannot cost the isolate. Before, each path went through
// `braces` with no range limit: `src/{1..100000000}/x.html` (25 characters)
// ran an isolate out of memory, and `{` nested 4,999 deep (9,998 characters)
// overflowed its stack, and `braces` (advisory GHSA-vfj7-8cjw-p6xm, no fixed
// version) was in the worker's dependencies.
//   - the reach is the part before the first glob character, to its last
//     `/`: exact for braces in the file part (`src/**/*.{html,js}`), a
//     superset for braces in the directory part;
//   - a `..` its alternatives could spell climbs a directory, so the reach
//     still covers `{../a,../b}/x`; a range spells no dot;
//   - leading braces that may spell a `/` reach from `/`; escapes in the
//     static part are decoded, as an expansion decodes them;
//   - a directory the walk's rules leave out (node_modules) that a source
//     names is walked, below an outside reach or inside the project, its
//     links out followed;
//   - Kinu's two paths each answer in bounded time (in a child, so a return
//     to expansion fails as a timeout, not a hung test), and the sheet's
//     other sources are still held.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as dataPlan from '../../packages/worker/src/facets/data-plan.ts';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

const { planStylesheetSources } = dataPlan;
const sourceReach = (path) => {
  if (typeof dataPlan.sourceReach !== 'function') throw new Error('no sourceReach');
  return dataPlan.sourceReach(path);
};

const failures = [];
const check = (name, body) => {
  try {
    body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

check('the part before the first glob character', () => {
  assert.equal(sourceReach('src/**/*.{html,js}'), 'src');
  assert.equal(sourceReach('../kit/**/*.{ts,tsx}'), '../kit');
  assert.equal(sourceReach('../shared'), '../shared', 'no glob: the path itself');
  assert.equal(sourceReach('*.tsx'), '.');
  assert.equal(sourceReach('/{a,b}/x'), '/');
  assert.equal(sourceReach('/home/user/app/../linked/**'), '/home/user/app/../linked');
  assert.equal(sourceReach('../{kit,app}/**/*.tsx'), '..', 'braces in the directory part: their parent');
  assert.equal(sourceReach('../range/{1..1001}.tsx'), '../range');
});

check('a `..` an alternative could spell', () => {
  assert.equal(sourceReach('{../a,../b}/x.html'), './../..', 'each pair of dots a group holds may climb');
  assert.equal(sourceReach('.{,x}./y'), './..', 'dots an empty alternative brings together');
  assert.equal(sourceReach('lib/{a.b,c}/x'), 'lib', 'one dot climbs nothing');
  assert.equal(sourceReach('lib/*.min.{js,css}'), 'lib', 'dots parted by what every expansion spells climb nothing');
  assert.equal(sourceReach('lib/{1..9}/{2..4}/x'), 'lib', 'a range spells no dot');
});

check('leading braces that may spell a `/`', () => {
  assert.equal(sourceReach('{/srv/ui,/opt/ui}/**/*.tsx'), '/');
  assert.equal(sourceReach('{,relative}/srv/ui/**'), '/', 'an empty alternative before a `/`');
  assert.equal(sourceReach('{{,x}/srv,y}/z'), '/', 'nested');
  assert.equal(sourceReach('{a,b}/x'), '.');
  assert.equal(sourceReach('{1..9}/x'), '.', 'a range spells a character');
  assert.equal(sourceReach('{-..0}x/y'), '/', 'one that may spell a `/`');
  assert.equal(sourceReach('{..,x}/a'), './..', 'a `..` is no `/`, but climbs');
  assert.equal(sourceReach('{x/y,z}/a'), '.', 'a `/` inside an alternative does not lead it');
  assert.equal(sourceReach('{x,{,/q}}/a'), '/', 'one that leads a nested alternative does');
});

check('escapes in the static part', () => {
  assert.equal(sourceReach('../back\\\\slash/{a,b}/x.html'), '../back\\slash', 'an escaped backslash is one');
  assert.equal(sourceReach('../back\\\\slash'), '../back\\slash', 'with no glob character too');
  assert.equal(sourceReach('lit\\{x\\}/y'), 'lit{x}/y', 'an escaped brace is no glob character');
  assert.equal(sourceReach('a\\*b/c*'), 'a*b');
});

check('the worker depends on no braces', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../packages/worker/package.json', import.meta.url), 'utf8'));
  const named = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies, ...manifest.devDependencies });
  assert.deepEqual(named.filter((name) => /braces/.test(name)), []);
});

/** A stand-in for the namespace a plan reads: `files` by path, `links` from path to target. */
function namespace(files, links = {}) {
  const real = (path) => {
    for (const [from, to] of Object.entries(links)) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
    return path;
  };
  const inside = (path) => (path === '' ? '' : `${path}/`);
  const kindOf = (path) => {
    if (Object.hasOwn(files, path)) return 'file';
    return Object.keys(files).some((name) => name.startsWith(inside(path))) ? 'directory' : null;
  };
  return {
    readText: async (path) => files[real(path)] ?? null,
    stat: async (path) => {
      const kind = kindOf(real(path));
      return kind === null ? null : { kind, size: kind === 'file' ? files[real(path)].length : 0 };
    },
    linkTarget: async (path) => {
      const target = links[path.replace(/^\//, '')];
      return target === undefined ? null : `/${target}`;
    },
    readdir: async (dir) => {
      const at = real(dir);
      const below = new Map();
      for (const name of [...Object.keys(files), ...Object.keys(links)]) {
        if (!name.startsWith(inside(at))) continue;
        const rest = name.slice(inside(at).length);
        const slash = rest.indexOf('/');
        const child = rest.slice(0, slash < 0 ? undefined : slash);
        below.set(child, Object.hasOwn(links, inside(at) + child) ? 'symlink' : slash < 0 ? 'file' : 'directory');
      }
      return [...below].map(([name, kind]) => ({ path: inside(dir) + name, kind, size: kind === 'file' ? files[inside(at) + name].length : 0 }));
    },
  };
}
const held = async (files, sheet, cwd, links) => {
  const planned = await planStylesheetSources(namespace(files, links), { cwd, home: '/home/user', sheets: [sheet] });
  return { held: planned.files.map((file) => file.path).sort(), roots: planned.roots };
};

try {
  const { held: absolute } = await held({
    'home/user/app/src/index.css': '@import "tailwindcss";\n@source "{/srv/ui,/opt/ui}/**/*.tsx";\n',
    'srv/ui/A.tsx': 'a', 'opt/ui/B.tsx': 'b',
  }, 'home/user/app/src/index.css', '/home/user/app');
  if (!absolute.includes('srv/ui/A.tsx') || !absolute.includes('opt/ui/B.tsx')) failures.push(`absolute alternatives are held: ${JSON.stringify(absolute)}`);

  const { held: escaped } = await held({
    'home/user/app/src/index.css': '@import "tailwindcss";\n@source "../../back\\\\\\\\slash/{a,b}/x.html";\n',
    'home/user/back\\slash/a/x.html': 'x',
  }, 'home/user/app/src/index.css', '/home/user/app');
  if (!escaped.includes('home/user/back\\slash/a/x.html')) failures.push(`an escaped backslash names its directory: ${JSON.stringify(escaped)}`);

  const { held: selected, roots: selectedRoots } = await held({
    'home/user/theme/theme.css': '@import "tailwindcss";\n@source "../{shared/node_modules/ui,kit}/**/*.tsx";\n',
    'home/user/shared/node_modules/ui/Card.tsx': 'c',
    'home/user/kit/Button.tsx': 'b',
  }, 'home/user/theme/theme.css', '/home/user/app');
  if (!selected.includes('home/user/shared/node_modules/ui/Card.tsx') || !selected.includes('home/user/kit/Button.tsx')) {
    failures.push(`a node_modules a source names is walked: ${JSON.stringify(selected)}`);
  }
  if (!selectedRoots.includes('/home/user/shared/node_modules/ui')) failures.push(`and pushed as its own root, below which push excludes it not: ${JSON.stringify(selectedRoots)}`);

  const { held: linked } = await held({
    'home/user/app/theme.css': '@import "tailwindcss";\n@source "./{node_modules/ui,other}/**/*.tsx";\n',
    'home/user/app/other/Plain.tsx': 'p',
    'srv/ui/Linked.tsx': 'l',
  }, 'home/user/app/theme.css', '/home/user/app', { 'home/user/app/node_modules/ui': 'srv/ui' });
  if (!linked.includes('srv/ui/Linked.tsx')) failures.push(`a link out of a named node_modules in the project is followed: ${JSON.stringify(linked)}`);
  if (linked.includes('home/user/app/other/Plain.tsx')) failures.push(`the project's own files are the project rule's: ${JSON.stringify(linked)}`);
} catch (error) {
  failures.push(`a plan threw: ${error.stack}`);
}

// Kinu's paths, through sourceReach and a plan, in a child bounded in time.
{
  const child = await runBoundedProcess(process.execPath, [fileURLToPath(new URL('./lib/source-reach-hazards.mjs', import.meta.url))], { timeoutMs: 30_000, name: 'source-reach-hazards' });
  if (!child.ok) {
    failures.push(`Kinu's paths: ${child.reason || `exit ${child.code}`}: ${String(child.stderr).slice(-600)}`);
  } else {
    const found = JSON.parse(String(child.stdout).trim().split('\n').pop());
    try {
      assert.deepEqual(found.reach, { nested: '.', commas: '.', range: 'src', deep: './../..' });
      assert.ok(found.held.includes('home/user/kit/Button.tsx'), `the sheet's other source is held: ${JSON.stringify(found.held)}`);
      assert.ok(found.held.includes('home/user/huge/1/x.html'), `the range's directory is held: ${JSON.stringify(found.held)}`);
    } catch (error) {
      failures.push(`Kinu's paths: ${error.message}`);
    }
  }
}

assert.deepEqual(failures, []);
console.log('data-plan-source-reach: an @source is never expanded; its reach is linear, and a superset');
