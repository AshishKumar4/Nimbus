#!/usr/bin/env bun

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { buildPipInvocation } from '../../packages/core/src/runtime/python-pip.ts';
import { FakeVfs, cwd, file, installMockPypi, markers, project, restoreFetch } from './lib/pypi-mock.mjs';
import {
  isRuntimePythonPackageArtifactMetadata,
  parseRuntimeManifest,
} from '../../packages/core/src/runtime/runtime-manifest.ts';

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
          'windows-only; sys_platform == "win32"',
          'urllib3<3,>=1.21.1',
        ],
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
    const invocation = await buildPipInvocation(['install', 'requests'], 'pip', cwd, new FakeVfs(), { home: '/home/user', network: ISOLATE_NETWORK, markers });
    assert.equal(invocation.mode, 'pip');
    for (const name of ['requests', 'certifi', 'charset-normalizer', 'idna', 'urllib3']) {
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
    const invocation = await buildPipInvocation(['install', '-r', 'requirements.txt', '-c', 'constraints.txt'], 'pip', cwd, vfs, { home: '/home/user', network: ISOLATE_NETWORK, markers });
    assert.equal(invocation.mode, 'pip');
    assert.match(invocation.code, /"canonicalName":"packaging","version":"24\.2"/);
    assert.doesNotMatch(invocation.code, /"canonicalName":"packaging","version":"25\.0"/);
  }

  // A constraints file's includes are constraints, -r too; a requirements
  // file's -c is constraints, and its -r requirements.
  {
    installMockPypi([
      project('packaging', {
        '24.2': [file('packaging', '24.2', 'packaging-24.2-py3-none-any.whl')],
        '25.0': [file('packaging', '25.0', 'packaging-25.0-py3-none-any.whl')],
      }),
      project('idna', { '3.11': [file('idna', '3.11', 'idna-3.11-py3-none-any.whl')] }),
      project('six', { '1.17.0': [file('six', '1.17.0', 'six-1.17.0-py3-none-any.whl')] }),
    ]);
    const vfs = new FakeVfs({
      'home/user/project/requirements.txt': '-r nested/more.txt\n-c pins/constraints.txt\n',
      'home/user/project/nested/more.txt': 'packaging\n',
      'home/user/project/pins/constraints.txt': '-r pinned.txt\n',
      'home/user/project/pins/pinned.txt': 'packaging==24.2\nidna==3.11\n',
    });
    const invocation = await buildPipInvocation(['install', '-r', 'requirements.txt', 'six'], 'pip', cwd, vfs, { home: '/home/user', network: ISOLATE_NETWORK, markers });
    assert.equal(invocation.mode, 'pip', invocation.error);
    assert.match(invocation.code, /"canonicalName":"packaging","version":"24\.2"/, 'the nested requirements file is requirements, pinned by the nested constraints');
    assert.doesNotMatch(invocation.code, /"canonicalName":"idna"/, 'a requirements file a constraints file includes is constraints, not requirements');
    assert.match(invocation.code, /"canonicalName":"six"/);
  }

  {
    const requirementsPath = 'home/user/project/requirements.txt';
    const invocation = await buildPipInvocation(
      ['install', '-r', 'requirements.txt'],
      'pip',
      cwd,
      new FakeVfs({}, [requirementsPath]),
      { home: '/home/user', network: ISOLATE_NETWORK, markers },
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
      { home: '/home/user', network: ISOLATE_NETWORK, markers },
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
      { home: '/home/user', network: ISOLATE_NETWORK, markers },
    );
    assert.equal(invocation.mode, 'none');
    assert.equal(invocation.exitCode, 1);
    assert.match(invocation.error || '', /cannot access local wheel \.\/local_pkg-0\.1\.0-py3-none-any\.whl: EACCES: permission denied/);
  }

  {
    const vfs = new FakeVfs({
      'home/user/project/local_pkg-0.1.0-py3-none-any.whl': new Uint8Array([1, 2, 3]),
    });
    const invocation = await buildPipInvocation(['install', './local_pkg-0.1.0-py3-none-any.whl'], 'pip', cwd, vfs, { home: '/home/user', network: ISOLATE_NETWORK, markers });
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
      { home: '/home/user', network: ISOLATE_NETWORK, markers },
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
    const invocation = await buildPipInvocation(['install', 'native-only'], 'pip', cwd, new FakeVfs(), { home: '/home/user', network: ISOLATE_NETWORK, markers });
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /native platform wheels|native Linux wheels/);
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
      { home: '/home/user', network: ISOLATE_NETWORK, markers },
    );
    assert.equal(invocation.mode, 'none');
    assert.match(invocation.error || '', /Pyodide\/Emscripten extension wheel/);
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
  // PyPI's answers are reused as pip's HTTP cache reuses them: for their
  // max-age, then fetched again, so a release published since is seen; an
  // answer without one is not reused by a later install.
  // Red before: an answer was kept forever, so a later install could not see
  // a new release, and every process's own network left its answers behind.
  {
    let fetches = 0;
    const versions = { '1.0.0': [file('fresh', '1.0.0', 'fresh-1.0.0-py3-none-any.whl')] };
    installMockPypi([project('fresh', versions), project('plain', { '1.0.0': [file('plain', '1.0.0', 'plain-1.0.0-py3-none-any.whl')] })]);
    const mocked = globalThis.fetch;
    globalThis.fetch = async (url) => {
      fetches++;
      const resp = await mocked(url);
      return { ...resp, headers: new Headers(String(url).includes('/plain/') ? {} : { 'cache-control': 'max-age=900, public' }) };
    };
    const realNow = Date.now;
    const network = { ...ISOLATE_NETWORK, id: 'npm-11' };
    const install = async (name) => (await buildPipInvocation(['install', name], 'pip', cwd, new FakeVfs(), { home: '/home/user', network, markers })).code;
    try {
      assert.match(await install('fresh'), /"version":"1\.0\.0"/);
      const first = fetches;
      await install('fresh');
      assert.equal(fetches, first, 'within its max-age, an answer is reused');
      versions['2.0.0'] = [file('fresh', '2.0.0', 'fresh-2.0.0-py3-none-any.whl')];
      Date.now = () => realNow() + 901_000;
      assert.match(await install('fresh'), /"version":"2\.0\.0"/, 'past its max-age, the release list was not fetched again');
      const plainBefore = fetches;
      await install('plain');
      const once = fetches - plainBefore;
      await install('plain');
      assert.ok(once > 0);
      assert.equal(fetches - plainBefore - once, once, 'an answer without a max-age was reused by a later install');
    } finally {
      Date.now = realNow;
    }
  }
} finally {
  restoreFetch();
}

console.log('python-pip: ok');
