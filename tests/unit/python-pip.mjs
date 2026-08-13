#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { buildPipInvocation } from '../../packages/core/src/runtime/python-pip.ts';
import {
  isRuntimePythonPackageArtifactMetadata,
  parseRuntimeManifest,
} from '../../packages/core/src/runtime/runtime-manifest.ts';

class FakeVfs {
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

const cwd = '/home/user/project';
const originalFetch = globalThis.fetch;

function file(name, version, filename, options = {}) {
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

function project(name, versions, requiresDist = {}) {
  return {
    name,
    versions,
    requiresDist,
  };
}

function pyodideLockfile(packages) {
  return JSON.stringify({
    info: {
      abi_version: '2025_0',
      arch: 'wasm32',
      platform: 'emscripten_4_0_9',
      python: '3.13.2',
    },
    packages,
  });
}

function installMockPypi(projects) {
  const byName = new Map(projects.map((pkg) => [pkg.name, pkg]));
  globalThis.fetch = async (rawUrl) => {
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
  };
}

try {
  {
    installMockPypi([
      project('requests', {
        '2.31.0': [file('requests', '2.31.0', 'requests-2.31.0-py3-none-any.whl')],
      }, {
        '2.31.0': [
          'certifi>=2017.4.17',
          'charset-normalizer<4,>=2',
          'idna<4,>=2.5; python_version >= "3"',
          'emscripten-only; sys_platform == "emscripten"',
          'windows-only; sys_platform == "win32"',
          'urllib3<3,>=1.21.1',
        ],
      }),
      project('emscripten-only', {
        '1.0.0': [file('emscripten-only', '1.0.0', 'emscripten_only-1.0.0-py3-none-any.whl')],
      }),
      project('windows-only', {
        '1.0.0': [file('windows-only', '1.0.0', 'windows_only-1.0.0-py3-none-any.whl')],
      }),
      project('certifi', {
        '2025.11.12': [file('certifi', '2025.11.12', 'certifi-2025.11.12-py3-none-any.whl')],
      }),
      project('charset-normalizer', {
        '3.4.4': [file('charset-normalizer', '3.4.4', 'charset_normalizer-3.4.4-py3-none-any.whl')],
      }),
      project('idna', {
        '3.11': [file('idna', '3.11', 'idna-3.11-py3-none-any.whl')],
      }),
      project('urllib3', {
        '2.6.0': [file('urllib3', '2.6.0', 'urllib3-2.6.0-py3-none-any.whl')],
      }),
    ]);
    const invocation = await buildPipInvocation(['install', 'requests'], 'pip', cwd, new FakeVfs());
    assert.equal(invocation.mode, 'pip');
    for (const name of ['requests', 'certifi', 'charset-normalizer', 'idna', 'urllib3', 'emscripten-only']) {
      assert.match(invocation.code, new RegExp(`"canonicalName":"${name}"`));
    }
    assert.doesNotMatch(invocation.code, /"canonicalName":"windows-only"/);
  }

  {
    installMockPypi([
      project('packaging', {
        '24.2': [file('packaging', '24.2', 'packaging-24.2-py3-none-any.whl')],
        '25.0': [file('packaging', '25.0', 'packaging-25.0-py3-none-any.whl')],
      }),
    ]);
    const vfs = new FakeVfs({
      'home/user/project/requirements.txt': 'packaging\n',
      'home/user/project/constraints.txt': 'packaging==24.2\n',
    });
    const invocation = await buildPipInvocation(['install', '-r', 'requirements.txt', '-c', 'constraints.txt'], 'pip', cwd, vfs);
    assert.equal(invocation.mode, 'pip');
    assert.match(invocation.code, /"canonicalName":"packaging","version":"24\.2"/);
    assert.doesNotMatch(invocation.code, /"canonicalName":"packaging","version":"25\.0"/);
  }

  {
    const requirementsPath = 'home/user/project/requirements.txt';
    const invocation = await buildPipInvocation(
      ['install', '-r', 'requirements.txt'],
      'pip',
      cwd,
      new FakeVfs({}, [requirementsPath]),
    );
    assert.equal(invocation.mode, 'none');
    assert.equal(invocation.exitCode, 1);
    assert.match(invocation.error || '', /cannot read requirements file requirements\.txt: EACCES: permission denied/);
  }

  {
    const constraintsPath = 'home/user/project/constraints.txt';
    const invocation = await buildPipInvocation(
      ['install', 'packaging', '-c', 'constraints.txt'],
      'pip',
      cwd,
      new FakeVfs({}, [constraintsPath]),
    );
    assert.equal(invocation.mode, 'none');
    assert.equal(invocation.exitCode, 1);
    assert.match(invocation.error || '', /cannot read constraints file constraints\.txt: EACCES: permission denied/);
  }

  {
    const wheelPath = 'home/user/project/local_pkg-0.1.0-py3-none-any.whl';
    const invocation = await buildPipInvocation(
      ['install', './local_pkg-0.1.0-py3-none-any.whl'],
      'pip',
      cwd,
      new FakeVfs({}, [wheelPath]),
    );
    assert.equal(invocation.mode, 'none');
    assert.equal(invocation.exitCode, 1);
    assert.match(invocation.error || '', /cannot access local wheel \.\/local_pkg-0\.1\.0-py3-none-any\.whl: EACCES: permission denied/);
  }

  {
    const vfs = new FakeVfs({
      'home/user/project/local_pkg-0.1.0-py3-none-any.whl': new Uint8Array([1, 2, 3]),
    });
    const invocation = await buildPipInvocation(['install', './local_pkg-0.1.0-py3-none-any.whl'], 'pip', cwd, vfs);
    assert.equal(invocation.mode, 'pip');
    assert.match(invocation.code, /"displayName":"local_pkg-0\.1\.0-py3-none-any"/);
    assert.match(invocation.code, /"path":"\/home\/user\/project\/local_pkg-0\.1\.0-py3-none-any\.whl"/);
  }

  {
    const vfs = new FakeVfs({
      'home/user/project/direct_ref-0.1.0-py3-none-any.whl': new Uint8Array([1, 2, 3]),
    });
    const invocation = await buildPipInvocation(
      ['install', 'direct-ref @ file:///home/user/project/direct_ref-0.1.0-py3-none-any.whl'],
      'pip',
      cwd,
      vfs,
    );
    assert.equal(invocation.mode, 'pip');
    assert.match(invocation.code, /"displayName":"direct-ref"/);
    assert.match(invocation.code, /"path":"\/home\/user\/project\/direct_ref-0\.1\.0-py3-none-any\.whl"/);
  }

  {
    installMockPypi([
      project('native-only', {
        '1.0.0': [file('native-only', '1.0.0', 'native_only-1.0.0-cp313-cp313-manylinux_2_28_x86_64.whl')],
      }),
    ]);
    const invocation = await buildPipInvocation(['install', 'native-only'], 'pip', cwd, new FakeVfs());
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /native platform wheels|native Linux wheels/);
  }

  {
    const numpyLockfile = pyodideLockfile({
      numpy: {
        depends: [],
        file_name: 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
        imports: ['numpy'],
        install_dir: 'site',
        name: 'numpy',
        package_type: 'package',
        sha256: '8'.repeat(64),
        version: '2.2.5',
      },
    });
    const invocation = await buildPipInvocation(
      ['install', 'numpy'],
      'pip',
      cwd,
      new FakeVfs(),
      {
        pyodideLockfileText: numpyLockfile,
      },
    );
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /numpy==2\.2\.5/);
    assert.match(invocation.error || '', /startup-loaded Python package artifact/);
    assert.match(invocation.error || '', /Request-time WebAssembly extension loading is not supported/);

    const artifactInvocation = await buildPipInvocation(
      ['install', 'numpy'],
      'pip',
      cwd,
      new FakeVfs(),
      {
        pyodideLockfileText: numpyLockfile,
        runtimeArtifacts: [{
          path: 'share/pyodide/packages/numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
          kind: 'python-package',
          id: 'pyodide-package:numpy@2.2.5',
          sha256: '1'.repeat(64),
          language: 'python',
          packageName: 'numpy',
          version: '2.2.5',
          abi: 'pyodide-emscripten-2025_0-wasm32',
          pyodideVersion: '0.29.4',
          pythonVersion: '3.13.2',
          wheelFileName: 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
          wheelSha256: '8'.repeat(64),
          loadMode: 'startup-module',
          imports: ['numpy'],
          dependencies: [],
          extensionModules: [{
            path: 'numpy/_core/_multiarray_umath.cpython-313-wasm32-emscripten.so',
            runtimePath: 'share/pyodide/packages/numpy/side-modules/numpy/_core/_multiarray_umath.cpython-313-wasm32-emscripten.so',
            sha256: '3'.repeat(64),
          }],
        }],
      },
    );
    assert.equal(artifactInvocation.mode, 'pip');
    assert.equal(artifactInvocation.pyodidePackages?.length, 1);
    assert.match(artifactInvocation.code, /pyodide_packages = /);
    assert.match(artifactInvocation.code, /_nimbus_install_pyodide_package/);
    assert.match(artifactInvocation.code, /_nimbus_record_pyodide_packages/);
  }

  {
    const invocation = await buildPipInvocation(
      ['install', 'numpy'],
      'pip',
      cwd,
      new FakeVfs(),
      { pyodideLockfileText: '{"packages":{"numpy":{}}}' },
    );
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /installed Pyodide lockfile is invalid/);
  }

  {
    const vfs = new FakeVfs({
      'home/user/project/numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl': new Uint8Array([1, 2, 3]),
    });
    const invocation = await buildPipInvocation(
      ['install', './numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl'],
      'pip',
      cwd,
      vfs,
    );
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /Pyodide\/Emscripten extension wheel/);
    assert.match(invocation.error || '', /startup-loaded Nimbus Python package artifact/);
  }

  {
    const manifest = parseRuntimeManifest({
      name: 'python',
      version: '0.29.4',
      license: 'MPL-2.0',
      wasi_namespace: null,
      files: [],
      entrypoints: [],
      runtime_artifacts: [{
        path: 'share/pyodide/packages/numpy.whl',
        kind: 'python-package',
        id: 'pyodide-package:numpy@2.2.5',
        sha256: '1'.repeat(64),
        language: 'python',
        packageName: 'numpy',
        version: '2.2.5',
        abi: 'pyodide-emscripten-2025_0-wasm32',
        pyodideVersion: '0.29.4',
        pythonVersion: '3.13.2',
        wheelFileName: 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
        wheelSha256: '2'.repeat(64),
        loadMode: 'startup-module',
        imports: ['numpy'],
        dependencies: [],
        extensionModules: [{
          path: 'numpy/_core/_multiarray_umath.cpython-313-wasm32-emscripten.so',
          runtimePath: 'share/pyodide/packages/numpy/side-modules/numpy/_core/_multiarray_umath.cpython-313-wasm32-emscripten.so',
          sha256: '3'.repeat(64),
        }],
      }],
    });
    assert.equal(manifest.runtime_artifacts?.length, 1);
    assert.equal(
      isRuntimePythonPackageArtifactMetadata(manifest.runtime_artifacts[0]),
      true,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('python-pip: ok');
