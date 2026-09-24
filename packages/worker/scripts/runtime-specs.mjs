/**
 * runtime-specs.mjs — every runtime Nimbus publishes, and how.
 *
 * One table, two readers: `bundle-runtime.mjs` stages a spec into R2 or into
 * an npm package directory, and `packages/core/scripts/check-runtime-packages.mjs`
 * refuses a core release while any spec with an `npm` entry is not on npm as
 * the `latest` build. A runtime joins the npm set by gaining an `npm` entry.
 */

import { BASH_RUNNER } from '@nimbus-sh/core/runtime/os-contracts.js';

/**
 * Static per-runtime spec. Each entry says where to fetch the upstream
 * file from and how to map it into the per-user VFS at install time.
 *
 * For `clang binji-2020`:
 *   - VFS path `bin/clang`          ← upstream `clang`         (31.2 MB)
 *   - VFS path `bin/wasm-ld`        ← upstream `lld`           (19.5 MB)
 *   - VFS path `share/clang/sysroot.tar`← upstream `sysroot.tar` (9.3 MB)
 *   - VFS path `LICENSE`            ← bundled APACHE-2.0 text
 */
export const SPECS = {
  'clang/binji-2020': {
    license: 'Apache-2.0-with-LLVM-exception',
    wasi_namespace: 'wasi_unstable',
    upstream_base: 'https://raw.githubusercontent.com/binji/wasm-clang/master',
    npm: {
      name: '@nimbus-sh/runtime-clang',
      summary: 'clang 8.0.1 and wasm-ld for wasm32-wasi, with a wasi-libc sysroot',
      // npm demands semver and this runtime's Nimbus version is a channel
      // name, so the compiler's own version is what the package carries. The
      // two namespaces stay separate: the manifest still says `binji-2020`,
      // and that is what the install root under ~/.nimbus/runtimes is named.
      version: '8.0.1',
    },
    files: [
      { src: 'clang',       vfs: 'bin/clang',                  mode: 'exec',   runner: 'clang-runner', binName: 'clang' },
      { src: 'lld',         vfs: 'bin/wasm-ld',                mode: 'exec',   runner: 'clang-runner', binName: 'wasm-ld', kind: 'linker' },
      { src: 'sysroot.tar', vfs: 'share/clang/sysroot.tar' },
    ],
    // Bundled LICENSE text — Apache 2.0 with LLVM exception (full text below).
    // Source: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT
    license_text: APACHE_2_LLVM_LICENSE_TEXT(),
  },
  // ── Ruby (v1, 2026-05-11) ────────────────────────────────────────
  // ruby.wasm 2.9.3-2.9.4 from npm @ruby/3.3-wasm-wasi (Ruby 3.3.x
  // built on WASI). We bundle ONLY the `ruby+stdlib.wasm` artifact
  // (34.3 MiB) — it's self-contained, stdlib is packed via wasi-vfs
  // into the wasm. No separate stdlib zip transport needed (unlike
  // Pyodide which ships python_stdlib.zip alongside the asm.js).
  //
  // Upstream channel: npm tarball — the script downloads the tarball
  // (`upstream_base + '/' + src`) and extracts the wasm by file
  // name via the `tarball_extract` flag. Each spec.files entry's
  // `src` is interpreted as the path INSIDE the extracted tarball.
  //
  // See /workspace/.seal-internal/2026-05-11-ruby-v1/audit.md for
  // the full artifact audit + import/export breakdown.
  'ruby/3.3.4': {
    license: 'Ruby+BSD-2-Clause',
    wasi_namespace: 'wasi_snapshot_preview1',
    upstream_base: 'https://registry.npmjs.org/@ruby/3.3-wasm-wasi/-/3.3-wasm-wasi-2.9.3-2.9.4.tgz',
    npm: {
      name: '@nimbus-sh/runtime-ruby',
      summary: 'Ruby 3.3.4 (ruby.wasm) for wasm32-wasi, with its stdlib packed in',
    },
    tarball_extract: 'package/dist',  // strip this prefix from src paths inside the tarball
    files: [
      // The Ruby wasm — includes Ruby 3.3.x interpreter + stdlib packed
      // via wasi-vfs. ruby-runner instantiates this at child-facet
      // module-init time and drives it via the Ruby ABI exports
      // (`ruby-init`, `ruby-init-loadpath`, `rb-eval-string-protect`).
      { src: 'ruby+stdlib.wasm', vfs: 'share/ruby/ruby+stdlib.wasm' },
      // User-facing bin entries. The shell registry dispatches `ruby`
      // and `ruby3` to ruby-runner; this file is a marker, not exec.
      { src: 'BIN_MARKER', vfs: 'bin/ruby',  mode: 'exec', runner: 'ruby-runner', binName: 'ruby' },
      { src: 'BIN_MARKER', vfs: 'bin/ruby3', mode: 'exec', runner: 'ruby-runner', binName: 'ruby3' },
    ],
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus ruby-runner launcher marker. The actual Ruby wasm\n' +
        '# lives in share/ruby/. This file is here only so `which ruby`\n' +
        '# and `ls bin/` find a regular file at the expected path. The\n' +
        '# shell-registry dispatches `ruby` directly to the ruby-runner\n' +
        '# factory; this file is not read or executed by Nimbus.\n',
        'utf8',
      ),
    },
    license_text: RUBY_LICENSE_TEXT(),
  },
  // ── GNU bash (fork runtime, 2026-07-20) ──────────────────────────
  // bash 5.2.37 cross-compiled to wasm32-wasi with the Nimbus process
  // overlay (nimbus-proc.{h,c}: fork/exec/wait/pipe over nimbus_proc.*
  // imports + asyncify-native setjmp) and asyncify-instrumented.
  // There is NO upstream binary channel — the artifacts are built from
  // source by packages/worker/wasm/bash/build-bash.sh (bash) and
  // coreutils/build-busybox.sh (BusyBox 1.37.0, the plain-WASI multicall
  // exec target providing ls/cat/cp/mv/rm/grep/sed/awk/find/... — see
  // busybox.applets), then staged from the local build tree via
  // `local_base`. The bash-runner aliases every applet name in
  // busybox.applets onto the busybox module so bash's PATH lookup finds
  // them in /bin and /usr/bin.
  //
  // The version is `<upstream>-<build>`: the build number advances with
  // every rebuild, and the entrypoint names the runner contract the build
  // was made for (BASH_RUNNER), so a deployment whose preamble predates it
  // never binds it. 5.2.37 is build 1, published under `bash-runner`.
  'bash/5.2.37-2': {
    license: 'GPL-3.0-or-later AND GPL-2.0-only',
    wasi_namespace: 'wasi_snapshot_preview1',
    local_base: '../wasm/bash',
    auxiliary_bins: 'coreutils/busybox.applets',
    npm: {
      name: '@nimbus-sh/runtime-bash',
      summary: 'GNU bash 5.2.37 and BusyBox 1.37.0, cross-compiled to wasm32-wasi',
      // 0.11.0 is the first core whose bash runner is BASH_RUNNER; 0.10.0 runs `bash-runner`.
      core: '>=0.11.0',
    },
    files: [
      { src: 'bash.async.wasm',           vfs: 'share/bash/bash.async.wasm' },
      { src: 'coreutils/busybox.wasm',    vfs: 'share/bash/coreutils/busybox.wasm' },
      { src: 'coreutils/busybox.applets', vfs: 'share/bash/coreutils/busybox.applets' },
      { src: 'BIN_MARKER', vfs: 'bin/bash', mode: 'exec', runner: BASH_RUNNER, binName: 'bash' },
    ],
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus bash-runner launcher marker. The real GNU bash wasm\n' +
        '# lives in share/bash/. The shell registry dispatches `bash`\n' +
        '# (and #!/bin/bash shebangs) to the bash-runner factory; this\n' +
        '# file exists so `which bash` and `ls bin/` find a regular,\n' +
        '# executable file at the expected path.\n',
        'utf8',
      ),
    },
    license_text: GPL_3_LICENSE_NOTICE(),
  },
  'python/0.29.4': {
    license: 'MPL-2.0',
    wasi_namespace: null,        // Pyodide is Emscripten, not WASI
    upstream_base: 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full',
    files: [
      // The wasm module Pyodide instantiates. Goes to share/ so the
      // user-VFS layout matches binji-clang's convention (bin/ for
      // exec entry, share/<name>/ for runtime-private blobs).
      { src: 'pyodide.asm.wasm', vfs: 'share/pyodide/pyodide.asm.wasm' },
      // The Emscripten JS half. Runtime sync adapts it once for
      // workerd and records that contract in manifest metadata; the
      // Python runner consumes the resulting artifact without patching
      // it during session boot.
      { src: 'pyodide.asm.js',   vfs: 'share/pyodide/pyodide.asm.js', transform: 'pyodide-workerd-adapter' },
      // Python 3.13 stdlib. Pyodide writes this into its Emscripten
      // MEMFS at /lib/python313.zip and CPython imports from there
      // via the ZipImporter on sys.path.
      { src: 'python_stdlib.zip', vfs: 'share/pyodide/python_stdlib.zip' },
      // Lockfile — only used by pyodide.loadPackage / micropip (v3
      // scope). We ship it so v3 doesn't need to re-bundle from
      // scratch; v1 ignores its contents.
      { src: 'pyodide-lock.json', vfs: 'share/pyodide/pyodide-lock.json' },
      // The user-facing "bin" — a tiny launcher marker. We don't
      // actually exec this file; the python-runner factory pulls
      // bytes from the share/ entries and ignores bin/python's
      // content. The presence of the entry in entrypoints[] is what
      // wires `python` into the shell registry.
      { src: 'BIN_MARKER',       vfs: 'bin/python',  mode: 'exec', runner: 'python-runner', binName: 'python' },
      // Second entrypoint — `python3` is conventional on Linux.
      { src: 'BIN_MARKER',       vfs: 'bin/python3', mode: 'exec', runner: 'python-runner', binName: 'python3' },
    ],
    license_text: MPL_2_LICENSE_TEXT(),
    /** Source 'BIN_MARKER' is synthesised, not fetched. */
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus python-runner launcher marker. The actual Pyodide\n' +
        '# bootstrap lives in share/pyodide/. This file is here only so\n' +
        '# `which python` and `ls bin/` find a regular file at the\n' +
        '# expected path. The shell-registry dispatches `python`\n' +
        '# directly to the python-runner factory; this file is not\n' +
        '# read or executed by Nimbus.\n',
        'utf8',
      ),
    },
    python_packages: ['numpy', 'markupsafe'],
  },

  // CPython 3.13 cross-built for wasm32-wasi by packages/worker/wasm/python/
  // build-python.sh, with the C libraries the published wasm32-wasi artifacts
  // leave out (zlib, bzip2, xz, sqlite, OpenSSL). Unlike the Pyodide entry
  // above this is a real WASI module: it talks to runtime/wasi/preamble.ts, so
  // it has no filesystem of its own to copy in and diff back out.
  //
  // Additive alongside python/0.29.4. Nothing reads these keys until
  // session/init.ts routes `python` at the cpython-runner factory.
  'cpython/3.13.14': {
    license: 'PSF-2.0',
    wasi_namespace: 'wasi_snapshot_preview1',
    local_base: '../wasm/python',
    npm: {
      name: '@nimbus-sh/runtime-cpython',
      summary: 'CPython 3.13.14, cross-compiled to wasm32-wasi, with its stdlib',
    },
    files: [
      { src: 'python.wasm',   vfs: 'share/cpython/python.wasm' },
      // The same interpreter with numpy and markupsafe's C speedups linked in,
      // and their Python half. wasm32-wasi has no dlopen, so a compiled package
      // is either in the binary or unavailable; the runner picks between the two
      // from what the session installed. Both ship because the choice is made
      // per invocation, inside the session, long after the install.
      { src: 'python-sci.wasm', vfs: 'share/cpython/python-sci.wasm' },
      // Beside the stdlib zip on purpose: the runner puts it on sys.path and
      // zipimport reads it out of the session filesystem, so it needs the same
      // treatment as lib/python313.zip and no separate transport.
      { src: 'sci-packages.zip', vfs: 'lib/sci-packages.zip' },
      // The stdlib, pyc-only. Read straight out of the session filesystem by
      // zipimport, which is why it needs no separate transport.
      // Laid out as a Python prefix, so nimbus_py_init can be handed the
      // install root directly. Aliasing lib/ onto some other path would put
      // entries in the guest's filesystem that the supervisor cannot serve,
      // and a manifest entry nobody can fetch is an EIO waiting to happen.
      { src: 'python313.zip', vfs: 'lib/python313.zip' },
      // OpenSSL has no default trust store to fall back on here: there is no
      // /etc/ssl in the session, so ssl.create_default_context() would verify
      // against nothing and every HTTPS fetch would fail. SSL_CERT_FILE points
      // at this. Mozilla's bundle, as published by curl.se.
      { src: 'cacert.pem',     vfs: 'etc/ssl/cert.pem' },
      { src: 'STDLIB_MARKER', vfs: 'lib/python3.13/os.py' },
      { src: 'BIN_MARKER', vfs: 'bin/python',  mode: 'exec', runner: 'cpython-runner', binName: 'python' },
      { src: 'BIN_MARKER', vfs: 'bin/python3', mode: 'exec', runner: 'cpython-runner', binName: 'python3' },
    ],
    license_text: PSF_LICENSE_NOTICE(),
    /** Source 'BIN_MARKER' is synthesised, not fetched. */
    synthetic_files: {
      'STDLIB_MARKER': Buffer.from(
        '# Nimbus stdlib marker. Every module is read from ../python313.zip;\n' +
        '# this file exists so the prefix looks like a Python prefix.\n',
        'utf8',
      ),
      'BIN_MARKER': Buffer.from(
        '# Nimbus cpython-runner launcher marker. The interpreter itself\n' +
        '# lives in share/cpython/. This file exists so `which python` and\n' +
        '# `ls bin/` find a regular, executable file at the expected path;\n' +
        '# the shell registry dispatches `python` directly to the\n' +
        '# cpython-runner factory and never reads this content.\n',
        'utf8',
      ),
    },
  },

  // 2026-05-11 sysroot-prep Phase 0 — R2 ingestion ONLY for the
  // clang-sysroot-swap wave. This entry stages the upstream wasi-sdk-19
  // sysroot in R2 (binji-shape: rootless `include/lib/share` layout) so
  // when the swap wave dispatches, the blob is already present.
  //
  // `ingest_only: true` SUPPRESSES the manifest write AND the catalog
  // auto-flip at the bottom of the script. The swap wave owns those
  // operations (it composes a new manifest that inherits bin/clang,
  // bin/wasm-ld from binji-2020 and references this
  // prep'd sysroot.tar blob, then flips `clang.default`).
  //
  // `repackage` describes a download+extract+retar pre-step that
  // produces a single local `sysroot.tar` file BEFORE the upload loop.
  // The file's `src` value is used as both the cached download filename
  // and (after repackage) the upload basename.
  'clang/wasi-sdk-19': {
    license: 'Apache-2.0-with-LLVM-exception',
    ingest_only: true,
    files: [
      // The upload loop sees one logical "file" with src='sysroot.tar'.
      // The repackage step below produces it from the upstream tarball
      // and writes it to <workDir>/sysroot.tar before the upload loop
      // runs. `vfs` mirrors the binji-2020 path for the swap wave's
      // manifest composer (kept for documentation only; ignored in
      // ingest_only mode since no manifest is written).
      { src: 'sysroot.tar', vfs: 'share/clang/sysroot.tar' },
    ],
    // Build-time step: fetch the upstream wasi-sdk-19 sysroot tarball,
    // extract, and re-tar in binji-2020 layout (rootless: include/, lib/,
    // share/ as top-level entries, no `wasi-sysroot/` prefix). Runs
    // BEFORE the existing fetch loop sees `sysroot.tar`.
    repackage: {
      upstream_url:
        'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-19/wasi-sysroot-19.0.tar.gz',
      // sha256 of the upstream .tar.gz, captured 2026-05-11.
      // Falsification: bundle-runtime.mjs verifies this on every run.
      upstream_sha256:
        'd601c901a26d6cdb158e60c8a981caa189e87875abc23bb071c2c533a39fd143',
      // Subdir inside the extracted tarball whose children become the
      // top-level entries of the produced sysroot.tar.
      strip_prefix: 'wasi-sysroot',
      // Directories at strip_prefix to include in the produced sysroot.tar.
      // Anything else under wasi-sysroot/ is dropped.
      include_dirs: ['include', 'lib', 'share'],
      // Expected sha256 of the *produced* sysroot.tar. Captured from a
      // dry-run inspection at /tmp/sysroot-prep-work/ (see prep audit).
      // Verified before upload; abort on mismatch.
      output_sha256:
        '82f30ed81d39072d54e3ba207305c26bfc29a7726e500230db3cad8abe828be3',
      // Expected raw byte size of the produced sysroot.tar.
      output_size: 11898880,
    },
    // license_text intentionally omitted — ingest_only mode skips the
    // bundled LICENSE write. The swap wave composes a concat-license
    // (binji + wasi-libc) at manifest time.
  },
};

/**
 * The specs published to npm: `runtime`/`version` are the bundle-runtime.mjs
 * arguments, `npmVersion` what the package.json carries.
 */
export function npmRuntimeSpecs() {
  return Object.entries(SPECS)
    .filter(([, spec]) => spec.npm && !spec.ingest_only)
    .map(([key, spec]) => {
      const [runtime, version] = key.split('/');
      return { runtime, version, name: spec.npm.name, npmVersion: spec.npm.version ?? version };
    });
}

// ── Bundled LICENSE text generator ────────────────────────────────
function GPL_3_LICENSE_NOTICE() {
  return `GNU bash 5.2.37 — GPL-3.0-or-later
Copyright (C) Free Software Foundation, Inc.

This runtime bundles GNU bash cross-compiled to wasm32-wasi. Full
license text: https://www.gnu.org/licenses/gpl-3.0.txt
Corresponding source: https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz
plus the Nimbus build overlay (packages/worker/wasm/bash/ in the
Nimbus repository: nimbus-proc.{h,c}, build-bash.sh, coreutils/).

BusyBox 1.37.0 — GPL-2.0-only
Copyright (C) many authors, 1998-2015. See the source distribution.

The coreutils exec targets (ls, cat, grep, sed, awk, find, ...) are
BusyBox cross-compiled to wasm32-wasi as one multicall binary. Full
license text: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
Corresponding source: https://busybox.net/downloads/busybox-1.37.0.tar.bz2
plus the Nimbus build overlay (packages/worker/wasm/bash/coreutils/ in
the Nimbus repository: build-busybox.sh, wasi-shim.c, overlay/).
`;
}

function PSF_LICENSE_NOTICE() {
  return [
    'Python is distributed under the Python Software Foundation License',
    'Version 2. The full text is at https://docs.python.org/3/license.html',
    'and is included in the interpreter as Lib/LICENSE.txt.',
    '',
    'Copyright (c) 2001-2026 Python Software Foundation. All Rights Reserved.',
    '',
    'This build is CPython 3.13.14 cross-compiled for wasm32-wasi and',
    'statically linked against zlib (zlib licence), bzip2 (BSD-like), xz',
    'liblzma (0BSD), SQLite (public domain) and OpenSSL 3.5 (Apache-2.0).',
    'Each of those carries its own licence, reproduced by its upstream.',
    '',
  ].join('\n');
}

function MPL_2_LICENSE_TEXT() {
  // Mozilla Public License 2.0 — Pyodide is MPL-2.0-licensed. We
  // ship an abbreviated header pointing at the canonical text; the
  // LICENSE file lives next to the runtime install dir as a
  // disclosure to the user.
  return [
    '==============================================================================',
    'Pyodide is licensed under the Mozilla Public License Version 2.0:',
    '==============================================================================',
    '',
    'Copyright (c) 2018-present Pyodide contributors.',
    '',
    'Full license: https://www.mozilla.org/en-US/MPL/2.0/',
    '',
    'Pyodide source: https://github.com/pyodide/pyodide',
    'Release tarball: https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
    '',
    'Bundled in Nimbus for the `nimbus install python` runtime. Python',
    'itself is under the PSF License Agreement (https://docs.python.org/3/',
    'license.html); pyodide.asm.wasm contains CPython 3.13 + selected',
    'standard-library modules statically linked to wasm32-unknown-emscripten.',
    '',
  ].join('\n');
}

function APACHE_2_LLVM_LICENSE_TEXT() {
  // Apache 2.0 with LLVM exception — abbreviated header pointing at
  // the canonical upstream LICENSE.TXT. We don't redistribute the
  // entire license verbatim here; the LICENSE file in the runtime
  // install dir tells the user where to find the full text.
  return [
    '==============================================================================',
    'The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:',
    '==============================================================================',
    '',
    'Copyright (c) The LLVM Project authors.',
    'Copyright (c) Ben Smith (binji) and contributors to wasm-clang.',
    '',
    'Full license: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT',
    '',
    'binji/wasm-clang source: https://github.com/binji/wasm-clang',
    'Original CppCon 2019 talk: https://www.youtube.com/watch?v=5N4b-rU-OAA',
    '',
    'This artifact is a frozen build of LLVM 8.0 from 2018-2020. It is bundled',
    'in Nimbus under the original LLVM Apache 2.0 + LLVM Exception license.',
    'See the canonical LICENSE.TXT for the full text including the WebAssembly',
    'runtime exception clauses.',
    '',
  ].join('\n');
}

function RUBY_LICENSE_TEXT() {
  // Ruby is dual-licensed under the Ruby License + BSD-2-Clause.
  // ruby.wasm packaging adds MIT for the JS bindings (which we
  // re-implement, so we don't redistribute their JS — only the wasm).
  // The wasm itself carries: Ruby License + BSD-2-Clause for the
  // interpreter, plus various permissive licenses for bundled gems
  // and the C extensions in stdlib.
  return [
    '==============================================================================',
    'Ruby is dual-licensed under the Ruby License (2-clause variant) and BSD-2-Clause:',
    '==============================================================================',
    '',
    'Copyright (c) Yukihiro Matsumoto. All rights reserved.',
    '',
    'Ruby License full text: https://www.ruby-lang.org/en/about/license.txt',
    'BSD-2-Clause full text: https://opensource.org/license/bsd-2-clause/',
    '',
    'Ruby source: https://github.com/ruby/ruby',
    'ruby.wasm source: https://github.com/ruby/ruby.wasm',
    'Release tarball: https://registry.npmjs.org/@ruby/3.3-wasm-wasi/-/3.3-wasm-wasi-2.9.3-2.9.4.tgz',
    '',
    'Bundled in Nimbus for the `nimbus install ruby` runtime. ruby+stdlib.wasm',
    'contains Ruby 3.3.x + the standard library packed via wasi-vfs, compiled',
    'to wasm32-unknown-wasi. The full Ruby standard library license list is in',
    'the upstream LEGAL file: https://github.com/ruby/ruby/blob/master/LEGAL.',
    '',
  ].join('\n');
}
