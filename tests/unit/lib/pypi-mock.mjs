// What pip (core runtime/python-pip.ts) reads and what it installs: a
// filesystem that holds a few files, PyPI's JSON API answered from fixtures
// (wheelhouse: real wheels, by file URL), the environment markers of the
// interpreter it plans for, and pipInstall, which runs its install as the
// CPython runner does, with the host's python3.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISOLATE_NETWORK } from '../../../packages/core/src/_shared/workspace-network.ts';
import { buildPipInvocation, pythonSitePackages } from '../../../packages/core/src/runtime/python-pip.ts';

export class FakeVfs {
  constructor(files = {}, deniedPaths = []) {
    this.files = new Map(Object.entries(files).map(([path, value]) => [
      path,
      typeof value === 'string' ? new TextEncoder().encode(value) : value,
    ]));
    this.deniedPaths = new Set(deniedPaths);
  }

  exists(path) {
    if (this.deniedPaths.has(path)) throw new Error(`EACCES: permission denied, access '/${path}'`);
    return this.files.has(path);
  }

  readFile(path) {
    const data = this.files.get(path);
    if (!data) throw new Error(`missing file: ${path}`);
    return data;
  }
}

export const cwd = '/home/user/project';

/** CPython 3.13.14's markers on wasm32-wasi. */
export const markers = {
  implementation_name: 'cpython',
  implementation_version: '3.13.14',
  os_name: 'posix',
  platform_machine: 'wasm32',
  platform_release: '0.0.0',
  platform_system: 'wasi',
  platform_version: '0.0.0',
  python_full_version: '3.13.14',
  platform_python_implementation: 'CPython',
  python_version: '3.13',
  sys_platform: 'wasi',
};

const originalFetch = globalThis.fetch;

export function restoreFetch() {
  Object.assign(globalThis, { fetch: originalFetch });
}

export function file(name, version, filename, options = {}) {
  return {
    filename,
    packagetype: filename.endsWith('.whl') ? 'bdist_wheel' : 'sdist',
    url: `https://files.example/${filename}`,
    digests: options.sha256 === false ? undefined : {
      sha256: options.sha256 || '0'.repeat(64),
    },
    yanked: false,
  };
}

export function project(name, versions, requiresDist = {}) {
  return {
    name,
    versions,
    requiresDist,
  };
}

/** PyPI's JSON API for `projects`, as the global fetch. */
export function installMockPypi(projects) {
  const byName = new Map(projects.map((pkg) => [pkg.name, pkg]));
  Object.assign(globalThis, { fetch: async (rawUrl) => {
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    assert.equal(parts[0], 'pypi');
    const name = parts[1];
    const version = parts[2] === 'json' ? null : parts[2];
    const pkg = byName.get(name);
    if (!pkg) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const releases = Object.fromEntries(Object.entries(pkg.versions).map(([ver, files]) => [ver, files]));
    const selectedVersion = version || Object.keys(pkg.versions).at(-1);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        info: {
          name: pkg.name,
          version: selectedVersion,
          requires_dist: pkg.requiresDist[selectedVersion] || [],
        },
        releases,
        urls: version ? pkg.versions[version] : [],
      }),
    };
  } });
}

/**
 * A scratch directory on the host, with a home and a project in it, and an
 * HTTP server for its files (the installer fetches over HTTP); `done`
 * stops the one and removes the other.
 */
export function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'nimbus-pip-'));
  const home = join(root, 'home');
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new Response(Bun.file(join(root, decodeURIComponent(new URL(request.url).pathname)))) });
  return {
    root, home, project: projectDir, url: (path) => `http://127.0.0.1:${server.port}/${encodeURIComponent(path)}`,
    done: () => {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * `projects` as PyPI serves them from `place` (scratch): each pure wheel
 * (py3-none-any) a real one, its module and its dist-info, by URL and
 * digest. Other files are left as they are, for the planner to refuse.
 */
export function wheelhouse(place, projects) {
  const dir = place.root;
  const pure = (entry) => entry.filename.endsWith('-py3-none-any.whl');
  writeWheels(projects.flatMap((pkg) => Object.entries(pkg.versions).flatMap(([version, files]) =>
    files.filter(pure).map((entry) => ({ path: join(dir, entry.filename), name: pkg.name, version })))));
  const served = (entry) => {
    const path = join(dir, entry.filename);
    return { ...entry, url: place.url(entry.filename), digests: { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  };
  return projects.map((pkg) => ({
    ...pkg,
    versions: Object.fromEntries(Object.entries(pkg.versions).map(([version, files]) => [version, files.map((entry) => (pure(entry) ? served(entry) : entry))])),
  }));
}

/** Each wheel of `wheels` ({ path, name, version }) written by python3's zipfile, as a pure wheel holds it. */
export function writeWheels(wheels) {
  const made = spawnSync('python3', ['-c', `
import json, sys, zipfile
for w in json.load(sys.stdin):
    module = w["name"].replace("-", "_").lower()
    dist = w["name"].replace("-", "_") + "-" + w["version"] + ".dist-info"
    with zipfile.ZipFile(w["path"], "w") as z:
        z.writestr(module + "/__init__.py", "VERSION = " + json.dumps(w["version"]) + "\\n")
        z.writestr(dist + "/METADATA", "Metadata-Version: 2.1\\nName: " + w["name"] + "\\nVersion: " + w["version"] + "\\n")
        z.writestr(dist + "/WHEEL", "Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
        z.writestr(dist + "/RECORD", "")
`], { input: JSON.stringify(wheels), encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

/** The host's filesystem, as pip's planner reads it (paths without the leading slash). */
const hostVfs = {
  exists: (path) => existsSync(`/${path.replace(/^\/+/, '')}`),
  readFile: (path) => new Uint8Array(readFileSync(`/${path.replace(/^\/+/, '')}`)),
};

/**
 * `pip install argv` in `place` (scratch's project, for its home): the plan
 * buildPipInvocation makes, run by python3 as the CPython runner runs it.
 * Answers why it failed, or each package the user's site-packages then
 * holds, as name==version from its METADATA.
 */
export async function pipInstall(argv, place, { network = ISOLATE_NETWORK, markers: environment = markers } = {}) {
  const invocation = await buildPipInvocation(['install', ...argv], 'pip', place.project, hostVfs, { home: place.home, network, markers: environment });
  if (invocation.mode !== 'pip') return { error: invocation.error ?? `pip planned no install (${invocation.mode})` };
  // Not spawnSync: the wheels are served from this process.
  const run = await new Promise((resolve) => {
    const child = spawn('python3', ['-c', invocation.code], { env: { ...process.env, no_proxy: '*', NO_PROXY: '*' } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (status) => resolve({ status, output }));
  });
  if (run.status !== 0) return { error: run.output };
  const site = `/${pythonSitePackages(place.home)}`;
  const installed = readdirSync(site).filter((entry) => entry.endsWith('.dist-info')).map((entry) => {
    const metadata = readFileSync(join(site, entry, 'METADATA'), 'utf8');
    return `${/^Name: (.*)$/m.exec(metadata)?.[1]}==${/^Version: (.*)$/m.exec(metadata)?.[1]}`;
  });
  return { installed: installed.sort() };
}
