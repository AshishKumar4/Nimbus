#!/usr/bin/env node
// Build the two compatibility fixtures, not an installable release.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.argv.length !== 3) throw new Error('usage: node build-compat.mjs <output-directory>');
const out = resolve(process.argv[2]);
const here = import.meta.dirname;
const env = { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOENV: 'off' };
const go = (args, options) => execFileSync('go', args, { env, encoding: 'utf8', ...options }).trim();
if (go(['env', 'GOVERSION']) !== 'go1.27.4') throw new Error('Go 1.27.4 is required');
const root = go(['env', 'GOROOT']);
const mod = JSON.parse(go(['mod', 'download', '-json', 'mvdan.cc/gofumpt@v0.12.0']));
// v0.12.0 = 3e07e7e70ac93761d8e79ca0083a19e3d59f753d; verify the source and dependency manifest.
if (mod.Sum !== 'h1:1Lbudkz2kpM9Cjz2pL4M19u7q+GaEhCTNf7N9mfpcho=' ||
    mod.GoModSum !== 'h1:SmBHHrljiZu/uoypeKup3rFzP6eoC9UwCp2iH5E3jZA=') {
  throw new Error('unexpected gofumpt source or go.mod checksum');
}

const work = mkdtempSync(join(tmpdir(), 'nimbus-gofumpt-build-'));
try {
  mkdirSync(out, { recursive: true });
  const src = join(work, 'gofumpt');
  cpSync(mod.Dir, src, { recursive: true });
  // The module cache's directories are read-only; make only the copy removable.
  chmodSync(src, 0o700);
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
  }
  const Replace = {};
  // Only the Wasm build sees these replacements. Anchor against the pinned
  // sources and refuse to build if an upstream edit moved or changed a hook.
  function patch(original, edits) {
    let text = readFileSync(original, 'utf8');
    for (const [before, after] of edits) {
      if (text.split(before).length !== 2) throw new Error(`overlay anchor mismatch in ${original}: ${before}`);
      text = text.replace(before, () => after);
    }
    const file = join(work, `${Object.keys(Replace).length}.go`);
    writeFileSync(file, text);
    Replace[original] = file;
  }

  Replace[join(root, 'src/syscall/nimbus_wasip1.go')] = join(here, 'nimbus_wasip1.go');
  patch(join(root, 'src/syscall/fs_wasip1.go'), [
    ['if cwd, _ = Getenv("PWD"); cwd != "" {\n\t\tcwd = joinPath("/", cwd)\n\t} else if len(preopens) > 0 {\n\t\tcwd = preopens[0].name\n\t}', 'nimbusInitCwd()'],
    ...[
      ['path_filestat_get(dirFd, LOOKUP_SYMLINK_FOLLOW, pathPtr, pathLen, unsafe.Pointer(st))', 'nimbusPathStat(dirFd, LOOKUP_SYMLINK_FOLLOW, pathPtr, pathLen, unsafe.Pointer(&raw))'],
      ['path_filestat_get(dirFd, 0, pathPtr, pathLen, unsafe.Pointer(st))', 'nimbusPathStat(dirFd, 0, pathPtr, pathLen, unsafe.Pointer(&raw))'],
      ['fd_filestat_get(int32(fd), unsafe.Pointer(st))', 'nimbusFdStat(int32(fd), unsafe.Pointer(&raw))'],
    ].map(([before, after]) => [`errno := ${before}\n\tsetDefaultMode(st)`, `var raw nimbusFileStat\n\terrno := ${after}\n\tif errno == 0 { raw.copyTo(st) }`]),
    ...[['fd_read', 'nread'], ['fd_write', 'nwritten']].map(([call, count]) => {
      const invoke = `${call}(int32(fd), makeIOVec(b), 1, &${count})`;
      return [`errno := ${invoke}`, `errno := nimbusWait(func() Errno { return ${invoke} })`];
    }),
    // gofumpt opens its backup with O_CREAT|O_EXCL. Preview 1 has no
    // creation mode argument: limit creation through umask, as nimbus_open
    // does, then restore it and add any requested executable bits.
    ['var fd int32\n\terrno := path_open(', `var fd int32
	const exclusiveCreate = OFLAG_CREATE | OFLAG_EXCL
	exclusive := oflags&exclusiveCreate == exclusiveCreate
	var mask, previous uint32
	if exclusive {
		if err := nimbusUmask(0, &mask); err != 0 { return -1, errnoErr(err) }
		defer nimbusUmask(mask, &previous)
		if err := nimbusUmask(mask | (^perm & 0777), &previous); err != 0 { return -1, errnoErr(err) }
	}
	errno := path_open(`],
    ['\treturn int(fd), errnoErr(errno)\n}\n\nfunc Close(', `	if errno == 0 && exclusive && perm &^ mask & 0111 != 0 {
		if errno = nimbusFdChmod(fd, perm &^ mask & 0777); errno != 0 {
			fd_close(fd)
			path_unlink_file(dirFd, pathPtr, pathLen)
			return -1, errnoErr(errno)
		}
	}
	return int(fd), errnoErr(errno)
}

func Close(`],
  ]);

  // Checkpoints in real formatting, not in a synthetic spin program.
  // Use the scanner's character path as a long string/comment is one token.
  function checkpoint(file, anchor) {
    patch(file, [['import (\n', 'import (\n\t"syscall"\n'], [anchor, `${anchor}\n\tsyscall.NimbusCheckpoint()`]]);
  }
  checkpoint(join(root, 'src/go/scanner/scanner.go'), 'func (s *Scanner) next() {');
  checkpoint(join(src, 'format/simplify.go'), 'func (s simplifier) Visit(node ast.Node) ast.Visitor {');
  checkpoint(join(src, 'format/format.go'), 'pre := func(c *astutil.Cursor) bool {');
  checkpoint(join(src, 'internal/govendor/go/printer/printer.go'), 'func (p *printer) print(args ...any) {');
  const overlay = join(work, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace }));

  const common = ['build', '-mod=readonly', '-trimpath', '-buildvcs=false'];
  const target = { ...env, GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0' };
  const host = { ...env, GOOS: go(['env', 'GOHOSTOS']), GOARCH: go(['env', 'GOHOSTARCH']), CGO_ENABLED: '0' };
  go([...common, '-o', join(out, 'gofumpt-native'), '.'], { cwd: src, env: host });
  const wasm = join(out, 'gofumpt.wasm');
  go([...common, '-overlay', overlay, '-o', wasm, '.'], { cwd: src, env: target });
  execFileSync(process.execPath, [join(here, '../nimbus-libc/verify-imports.mjs'), wasm], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
