#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INSTALL = 'bun scripts/install-deps.mjs';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--patch-only')) {
    console.error(`usage: ${INSTALL} [--patch-only]`);
    process.exit(2);
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const commands = [
    // A sharp tarball download failed once; retry installation, not patches.
    ...(args.length === 0 ? [{ command: process.execPath, args: ['install', '--frozen-lockfile', '--ignore-scripts'], attempts: 2 }] : []),
    { command: 'node', args: ['packages/worker/scripts/patch-install-deps.mjs'], attempts: 1 },
  ];
  for (const step of commands) {
    let status = 2;
    for (let attempt = 0; attempt < step.attempts; attempt++) {
      const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' });
      if (result.error) console.error(result.error.message);
      status = result.status ?? 2;
      if (status === 0) break;
    }
    if (status !== 0) process.exit(status);
  }
}
