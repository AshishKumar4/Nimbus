#!/usr/bin/env bun
// Every tool reads and writes the paths it is given through the namespace as
// the calling principal, so a tool on an asynchronous mount (no `sync` face,
// every call awaited: an embedder's drive, device or container) answers what
// it answers in the SQLite home. Kinu's repro lines (ASK-mounts items 2, 3, 4
// and 6), run through composeHostedRuntime with such a mount at /m, against
// the same lines in /home/user:
//   - a script run by its path, absolute and relative, runs, and the rest of
//     the line runs (it answered EAGAIN and aborted the line); a mount whose
//     backend fails fails that command, never the line, and so does a name
//     looked up from a cwd inside one (the line ended with status 2);
//   - git init/config/add/commit/status/log work, and .git lands in the mount
//     (git created `m` in the SQLite root as root: EACCES); from a mount's
//     link into SQLite, git works the repository the link names;
//   - npm run, npm ls, npm init and npm uninstall read and write the mounted
//     package.json (npm run answered ENOENT), and the project's own bins
//     run bare, in a script and through npx (command not found); as the
//     user they now act as, npm uninstall and npm init update a package.json
//     an earlier release wrote as root, and a root-only one fails them;
//   - bun run finds the package.json script and the file (Script not found);
//   - the Worker and vite dev servers, which serve through the engine, refuse
//     a mounted project by name, judged by the root they serve, not the cwd.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const root = new URL('../../', import.meta.url).pathname;
// The mount's errors must be the bundle's VfsError, so it is bundled with the runtime.
const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/vfs/vfs-error.ts': ['VfsError'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
  'tests/unit/lib/async-memory-vfs.mjs': ['asyncMemoryVfs'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = stagedAssets;
const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS };

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
workspace.filesystem.vfs.mount('/m', bundle.asyncMemoryVfs());
// A backend that cannot answer at all: its failure is the command's.
const broken = () => { throw new bundle.VfsError('EIO', 'the device is gone', '/'); };
workspace.filesystem.vfs.mount('/gone', { stat: broken, readFile: broken, writeFile: broken, readdir: broken, mkdir: broken, unlink: broken });
// One that answers for its directory `sub` and fails everything under it: a
// cwd there reaches the mount on every name the shell looks up.
const sick = async (path) => {
  if (path === '/' || path === '/sub') return { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40755, uid: 1000, gid: 1000 };
  broken();
};
workspace.filesystem.vfs.mount('/sick', { stat: sick, readFile: broken, writeFile: broken, readdir: broken, mkdir: broken, unlink: broken });
const runtime = await bundle.composeHostedRuntime({
  workspace, ctx, env,
  ports: new bundle.PortRegistry(),
  lifecycle: { waitUntil: (task) => { facetCtx.waitUntil(task); }, async schedule() {}, async cancel() {} },
});

/** One line in /m and in /home/user: each result, with the mounted one's paths spelled as the home's. */
async function both(line) {
  const home = await runtime.exec(line.replaceAll('{dir}', '/home/user'));
  const mount = await runtime.exec(line.replaceAll('{dir}', '/m'));
  const spelled = (text) => text.replaceAll('/m/', '/home/user/').replaceAll('/m\n', '/home/user\n').replaceAll('Wrote to m/', 'Wrote to home/user/');
  return { home, mount: { ...mount, stdout: spelled(mount.stdout), stderr: spelled(mount.stderr) } };
}

const onEngine = (path) => vfs.as(bundle.CRED_KERNEL).exists(path);

try {
  // ── item 2: a script run by its path ────────────────────────────────────
  {
    const { home, mount } = await both("mkdir -p {dir}/s && printf '#!/bin/sh\\necho ran-by-path\\n' > {dir}/s/s.sh && chmod +x {dir}/s/s.sh; "
      + '{dir}/s/s.sh; echo abs-exit=$?; cd {dir}/s && ./s.sh; echo rel-exit=$?; sh {dir}/s/s.sh; echo sh-exit=$?; echo line-end');
    assert.equal(home.stdout, 'ran-by-path\nabs-exit=0\nran-by-path\nrel-exit=0\nran-by-path\nsh-exit=0\nline-end\n', home.stderr);
    assert.deepEqual({ stdout: mount.stdout, stderr: mount.stderr }, { stdout: home.stdout, stderr: home.stderr }, 'by path on the mount, as in the home');
    const gone = await runtime.exec('/gone/x; echo after=$?');
    assert.equal(gone.stdout, 'after=126\n', 'a failing mount fails the command; the line goes on');
    assert.match(gone.stderr, /^\/gone\/x: EIO/);
    console.log('  [2] a script on the mount runs by its path; nothing aborts the line');
  }

  // ── a cwd inside a failing mount fails only the command it names ───────
  {
    const line = await runtime.exec('cd /sick/sub && typo-cmd; echo after=$?; ./s.sh; echo after2=$?');
    assert.equal(line.stdout, 'after=127\nafter2=126\n', line.stderr);
    assert.match(line.stderr, /typo-cmd: command not found/);
    assert.match(line.stderr, /\.\/s\.sh: EIO/);
    console.log('  a name looked up under a failing mount is not found or fails alone; the line goes on');
  }

  // ── item 3: git ─────────────────────────────────────────────────────────
  {
    const { home, mount } = await both('mkdir -p {dir}/g2 && cd {dir}/g2 && echo x > a.txt && git init -q; echo init=$?; '
      + 'git config user.email a@b.c; git config user.name n; git add a.txt; echo add=$?; git commit -q -m one; echo commit=$?; '
      + 'git status --short; echo status=$?; git log --oneline');
    const oid = (text) => text.replace(/[0-9a-f]{7}/g, '<oid>');
    // status --short is git's: nothing at all for a clean tree.
    assert.equal(oid(home.stdout), 'init=0\nuser.email=a@b.c\nuser.name=n\nadd=0\ncommit=0\nstatus=0\n\x1b[33m<oid>\x1b[0m one\n', home.stderr);
    assert.deepEqual({ stdout: oid(mount.stdout), stderr: mount.stderr }, { stdout: oid(home.stdout), stderr: home.stderr }, 'git on the mount, as in the home');
    assert.equal((await workspace.filesystem.vfs.stat('/m/g2/.git/HEAD'))?.type, 'file', '.git is on the mount');
    assert.equal(onEngine('m'), false, 'and nothing of it in SQLite');
    // A clone onto the mount is taken (not refused for where it is); one that cannot reach its
    // remote fails, and leaves nothing there.
    const clone = await runtime.exec('cd /m && git clone https://example.invalid/r.git; echo clone=$?');
    assert.doesNotMatch(clone.stderr, /only on the workspace filesystem/, 'a mounted destination is not refused');
    assert.match(clone.stdout, /clone=[1-9]/, clone.stderr);
    assert.equal(await workspace.filesystem.vfs.stat('/m/r'), null, 'a failed clone there leaves nothing');
    console.log('  [3] git works a repository on the mount through the namespace, as the caller; a clone there is taken');
  }

  // ── a mount's link into SQLite is the project it names ──────────────────
  {
    const line = await runtime.exec('mkdir -p /home/user/lk && cd /home/user/lk && echo x > a.txt && git init -q && git config user.email a@b.c && git config user.name n '
      + '&& git add a.txt && git commit -q -m one && echo y > b.txt; ln -s /home/user/lk /m/link && cd /m/link && pwd && git status --short; echo status=$?; git log --oneline');
    assert.equal(line.stdout.replace(/[0-9a-f]{7}/g, '<oid>'),
      'user.email=a@b.c\nuser.name=n\n/m/link\n?? b.txt\nstatus=0\n\x1b[33m<oid>\x1b[0m one\n', line.stderr);
    console.log('  git in a mount\'s link into SQLite works the repository the link names');
  }

  // ── item 4: npm run / ls / init / uninstall ─────────────────────────────
  {
    const { home, mount } = await both('mkdir -p {dir}/p && cd {dir}/p && printf \'{"name":"p","version":"1.0.0","dependencies":{"a":"1.0.0"},"scripts":{"hello":"echo hello-script"}}\' > package.json '
      + '&& npm run hello; echo run=$?; npm ls; echo ls=$?; npm uninstall a; echo un=$?; cat package.json; '
      + 'mkdir {dir}/p/i && cd {dir}/p/i && npm init -y; echo init=$?; cat package.json');
    assert.match(home.stdout, /hello-script\nrun=0\n/, home.stderr);
    assert.match(home.stdout, /un=0\n\{[^]*"dependencies": \{\}/);
    assert.match(home.stdout, /init=0\n\{[^]*"name": "i"/);
    assert.deepEqual({ stdout: mount.stdout, stderr: mount.stderr }, { stdout: home.stdout, stderr: home.stderr }, 'npm on the mount, as in the home');
    console.log('  [4] npm run, ls, uninstall and init read and write the mounted package.json');
  }

  // ── item 4: a project's own bins, bare, in npm run and through npx ─────
  {
    const { home, mount } = await both("mkdir -p {dir}/q/node_modules/.bin && cd {dir}/q && printf '#!/bin/sh\\necho tool \"$@\"\\n' > node_modules/.bin/tool "
      + '&& chmod +x node_modules/.bin/tool && printf \'{"name":"q","version":"1.0.0","scripts":{"b":"tool 1.2.3"}}\' > package.json '
      + '&& npm run b; echo run=$?; npx tool 4.5.6; echo npx=$?; tool 7; echo bare=$?');
    assert.match(home.stdout, /> tool 1\.2\.3\n\ntool 1\.2\.3\nrun=0\ntool 4\.5\.6\nnpx=0\ntool 7\nbare=0\n$/, home.stderr);
    assert.deepEqual({ stdout: mount.stdout, stderr: mount.stderr }, { stdout: home.stdout, stderr: home.stderr }, 'the mounted bin, as the home\'s');
    assert.equal(onEngine('tmp/.npx-cache'), false, 'npx ran the project\'s bin and installed nothing');
    console.log('  [4] a mounted project\'s node_modules/.bin runs bare, in npm run and through npx');
  }

  // ── a package.json an earlier release wrote as root is the user's to update ──
  {
    await runtime.exec('mkdir -p /home/user/o /home/user/oi /home/user/os');
    const kernel = vfs.as(bundle.CRED_KERNEL);
    kernel.writeFile('home/user/o/package.json', JSON.stringify({ name: 'o', dependencies: { a: '1.0.0', b: '1.0.0' } }));
    kernel.writeFile('home/user/oi/package.json', '{}');
    kernel.writeFile('home/user/os/package.json', JSON.stringify({ name: 'os', dependencies: { a: '1.0.0' } }), { mode: 0o600 });
    const line = await runtime.exec('cd /home/user/o && npm uninstall a; echo un=$?; cat package.json; '
      + 'cd /home/user/oi && npm init -y >/dev/null; echo init=$?; grep -c \'"name": "oi"\' package.json; '
      + 'cd /home/user/os && npm uninstall a; echo root-only=$?');
    assert.match(line.stdout, /^removed a\nun=0\n\{\n {2}"name": "o",\n {2}"dependencies": \{\n {4}"b": "1\.0\.0"\n {2}\}\n\}\ninit=0\n1\nremoved a\nroot-only=1\n$/, line.stdout + line.stderr);
    assert.match(line.stderr, /npm ERR! could not update package\.json: EACCES/);
    assert.equal(kernel.stat('home/user/os/package.json').uid, 0, 'a root-only package.json stays root\'s');
    console.log('  npm uninstall and init update a package.json an earlier release wrote as root; a root-only one fails them');
  }

  // ── item 6: bun run ─────────────────────────────────────────────────────
  {
    const { home, mount } = await both('mkdir -p {dir}/b && cd {dir}/b && printf \'{"name":"b","scripts":{"hello":"echo hello-bun"}}\' > package.json '
      + '&& echo \'console.log("ran-ts")\' > s.ts && bun run hello; echo run=$?; bun run nothing; echo missing=$?');
    assert.equal(home.stdout, 'hello-bun\nrun=0\nmissing=1\n', home.stderr);
    assert.deepEqual({ stdout: mount.stdout, stderr: mount.stderr }, { stdout: home.stdout, stderr: home.stderr }, 'bun run on the mount, as in the home');
    // A file target resolves on the mount and runs as `bun s.ts` runs, whatever this host's facets make of it.
    const file = await both('cd {dir}/b && bun run s.ts; echo bunrun=$?');
    assert.doesNotMatch(file.mount.stderr, /Script not found/, file.mount.stderr);
    assert.deepEqual({ stdout: file.mount.stdout, stderr: file.mount.stderr }, { stdout: file.home.stdout, stderr: file.home.stderr });
    console.log('  [6] bun run finds the mounted script and file');
  }

  // ── the dev servers serve through the engine: they say so ──────────────
  {
    const dev = await runtime.exec('mkdir -p /m/w && cd /m/w && echo {} > wrangler.jsonc && nimbus-wrangler dev; echo wrangler=$?; vite; echo vite=$?');
    assert.equal(dev.stdout, 'wrangler=1\nvite=1\n', dev.stderr);
    assert.match(dev.stderr, /Worker dev server serves only projects on the workspace filesystem; \/m\/w is on a mounted one/);
    assert.match(dev.stderr, /vite: the dev server serves only projects on the workspace filesystem; \/m\/w is on a mounted one/);
    // What decides is the root the server serves, not the cwd it was started from.
    const rooted = await runtime.exec('mkdir -p /m/app && cd /home/user && vite --root /m/app; echo vite=$?');
    assert.equal(rooted.stdout, 'vite=1\n', rooted.stderr);
    assert.match(rooted.stderr, /vite: the dev server serves only projects on the workspace filesystem; \/m\/app is on a mounted one/);
    const home = await runtime.exec('mkdir -p /home/user/app && cd /m/w && vite --root /home/user/app; echo vite=$?; vite stop');
    assert.doesNotMatch(home.stderr, /serves only projects on the workspace filesystem/, home.stderr);
    assert.match(home.stdout, /Root: {7}\/home\/user\/app\n[^]*vite=0\n/, home.stdout + home.stderr);
    console.log('  the Worker and vite dev servers refuse a mounted project by the root they serve');
  }
} finally {
  await runtime.close();
}

console.log('async-mount-hosted-tools OK');
