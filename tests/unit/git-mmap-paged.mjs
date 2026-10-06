#!/usr/bin/env bun
// The paging backend underneath Git's NO_MMAP hooks: compare every range
// with a real native mmap, including page edges, eviction, whole-map users,
// close/reopen and short files. No Git build/download is needed for this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'git-mmap-paged-'));
const backend = new URL('../../packages/worker/wasm/git/git-mmap-paged.c', import.meta.url).pathname;
const source = `
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#define die(...) do { fprintf(stderr, __VA_ARGS__); exit(128); } while (0)
#define die_errno(...) die(__VA_ARGS__)
#define BUG(...) die(__VA_ARGS__)
static size_t cached;
static size_t st_mult(size_t a, size_t b) { return a * b; }
static void *xmalloc(size_t n) { void *p = malloc(n); if (!p) exit(99); cached += n; return p; }
static ssize_t pread_in_full(int fd, void *out, size_t n, off_t at) {
  size_t done = 0;
  while (done < n) { ssize_t got = pread(fd, (char *)out + done, n - done, at + done); if (got <= 0) return got; done += got; }
  return done;
}
static void *git_mmap(void *start, size_t n, int prot, int flags, int fd, off_t at) {
  (void)start; (void)prot; (void)flags;
  void *out = malloc(n);
  if (!out || pread_in_full(fd, out, n, at) != (ssize_t)n) exit(98);
  return out;
}
static void *xmmap(void *p, size_t n, int prot, int flags, int fd, off_t at) { return git_mmap(p, n, prot, flags, fd, at); }
#include "${backend}"
#define check(condition) do { if (!(condition)) { fprintf(stderr, "line %d", __LINE__); exit(1); } } while (0)
int main(int argc, char **argv) {
  size_t size = 80 * 65536 + 37;
  int fd = open(argv[1], O_RDONLY);
  check(fd >= 0);
  unsigned char *native = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  check(native != MAP_FAILED);
  void *paged = git_mmap_paged(fd, size);
  check(paged != MAP_FAILED);
  if (argc > 2) { git_mmap_read(paged, size - 2, 3); return 0; }
  for (size_t at = 0; at + 20 < size; at += 997)
    check(!memcmp(git_mmap_read(paged, at, 20), native + at, 20));
  for (size_t page = 1; page < 80; page++) {
    size_t at = page * 65536 - 7;
    check(!memcmp(git_mmap_read(paged, at, 20), native + at, 20));
  }
  check(!memcmp(git_mmap_read(paged, size - 37, 37), native + size - 37, 37));
  check(cached <= 4 * 1024 * 1024);
  check(!memcmp(git_mmap_whole(paged), native, size));
  git_munmap_paged(paged);
  free(paged);
  check(fcntl(fd, F_GETFD) == -1 && errno == EBADF);
  munmap(native, size);
  // Reuse after close must not revive pages tagged with a freed mapping.
  fd = open(argv[1], O_RDWR);
  unsigned char replacement = 126;
  check(pwrite(fd, &replacement, 1, 65536 + 3) == 1);
  paged = git_mmap_paged(fd, size);
  check(*git_mmap_read(paged, 65536 + 3, 1) == replacement);
  git_munmap_paged(paged);
  free(paged);
  fd = open(argv[1], O_RDONLY);
  void *small = git_mmap_paged(fd, 123);
  check(!memcmp(git_mmap_read(small, 111, 12), git_mmap_whole(small) + 111, 12));
  git_munmap_paged(small);
  free(small);
  puts("ranges, eviction, whole-map and descriptor ownership match native mmap");
}
`;
try {
  const bytes = Uint8Array.from({ length: 80 * 65536 + 37 }, (_, i) => (i * 31 + (i >>> 16)) & 255);
  const file = join(root, 'data');
  writeFileSync(file, bytes);
  writeFileSync(join(root, 'probe.c'), source);
  const binary = join(root, 'probe');
  const built = spawnSync('cc', ['-std=c11', '-D_GNU_SOURCE', '-Wall', '-Wextra', '-Werror', '-O2', join(root, 'probe.c'), '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(binary, [file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /match native mmap/);
  const bad = spawnSync(binary, [file, 'out-of-range'], { encoding: 'utf8' });
  assert.equal(bad.status, 128, bad.stderr);
  assert.match(bad.stderr, /offset beyond end/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('git-mmap-paged: native mmap differential passed');
