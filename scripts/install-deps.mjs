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
    ...(args.length === 0 ? [[process.execPath, ['install', '--frozen-lockfile', '--ignore-scripts']]] : []),
    ['node', ['packages/worker/scripts/patch-install-deps.mjs']],
  ];
  for (const [command, argv] of commands) {
    const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 2);
  }
}
