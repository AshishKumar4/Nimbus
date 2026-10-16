// What pip's planner (core runtime/python-pip.ts) reads: a filesystem that
// holds a few files, PyPI's JSON API answered from fixtures, and the
// environment markers of the interpreter it plans for.

import assert from 'node:assert/strict';

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
