// The shell's Unix commands run one at a time, as the shell invokes them but
// without a shell: a principal's credential and view, collected output, and
// the elevation and umask seams a test plays the kernel for.

import { createDefaultRegistry } from '../../../packages/core/src/substrate/lifo/commands/registry.ts';
import { registerUnixCommands } from '../../../packages/core/src/shell/unix-commands.ts';

/** The default command registry with the Unix commands registered over `rawVfs`. */
export function unixCommandRegistry(rawVfs) {
  const registry = createDefaultRegistry();
  registerUnixCommands(registry, rawVfs);
  return registry;
}

/**
 * Run `name` from `registry` once, as `cred` over its view of `rawVfs`.
 * `pid`, `setUmask` and `runAs` reach the command only when given.
 *
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function runCommand(registry, rawVfs, name, args, { cred, cwd = '/', env = {}, pid, setUmask, runAs } = {}) {
  const command = await registry.resolve(name);
  if (!command) throw new Error(`${name} is not registered`);
  let stdout = '';
  let stderr = '';
  const exitCode = await command({
    args,
    cwd,
    env,
    cred,
    vfs: rawVfs.as(cred),
    ...(pid === undefined ? {} : { pid }),
    ...(setUmask === undefined ? {} : { setUmask }),
    ...(runAs === undefined ? {} : { runAs }),
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout, stderr };
}

/** The runCommand options of process `pid` in `processes`: its pid, credential and umask seam. */
export function asProcess(processes, pid) {
  return { pid, cred: processes.credOf(pid), setUmask: (mask) => processes.setUmask(pid, mask) };
}
