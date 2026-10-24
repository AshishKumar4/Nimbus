/**
 * wasi-cli-runner.ts — a plain WASI command (jq, make) as a command
 * (WASI_CLI_RUNNER).
 *
 * Each invocation is one WASI process in a facet: the entrypoint's own
 * installed file (`bin/<name>`) as the image, the session root as its only
 * preopen, the caller's credential, and the caller's working directory, which
 * the image changes to before main (nimbus_proc.startup_dir, nimbus-cwd.c),
 * so a relative path and an absolute one mean what they mean in the shell.
 * Like git (git-runner.ts), it is a process of its own (runtime-stdio.ts):
 * its output goes to the session byte for byte as it writes it, the caller's
 * input is pumped to it, and a child it starts (make's recipe lines) is an
 * ordinary session process, started through the session's child-process
 * route (wasi/processes.ts). A run that ended clean leaves its facet warm for
 * the next run of the same image.
 */
import { installedPath } from './runtime-manifest.js';
import { hostImage } from './process-files.js';
import { takesOwnSignals } from './facet-host.js';
import { warmFacetKeys } from './warm-facets.js';
import { WASI_CLI_CALL_TASK } from './compiled-bodies.generated.js';
import { CRED_KERNEL, gateSyncLaunch, requireVfsCred } from './os-contracts.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { openRuntimeStdio } from './runtime-stdio.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
/** A command may run as long as a facet invocation may. */
const WASI_CLI_TIMEOUT_MS = 300_000;
export function makeWasiCliRunnerFactory(deps) {
    // The image restarts the waits its host gives up on and raises its signals (WASI_CLI_RUNNER).
    const takesSignals = takesOwnSignals(deps.facets, true);
    return function wasiCliRunnerFactory(manifest, installRoot, binName) {
        const wasmPath = installedPath(manifest, installRoot, `bin/${binName}`);
        // One image's warm facets: the runtime's, at its version, and the command's.
        const warmKeys = warmFacetKeys(deps.session, `wasi-cli:${manifest.name}@${manifest.version}:${binName}`);
        return async function wasiCliBinHandler(ctx) {
            const argv = ctx.args || [];
            const cwd = ctx.cwd || '/home/user';
            const notHydrated = await gateSyncLaunch(ctx.vfs.process, cwd, null, argv);
            if (notHydrated !== null) {
                await ctx.stderr.write(`${binName}: ${notHydrated}\n`);
                return 1;
            }
            if (wasmPath === null) {
                await ctx.stderr.write(`${binName}: bin/${binName} missing from the install\n`);
                return 127;
            }
            const cred = requireVfsCred(ctx.cred, binName);
            let image;
            try {
                image = await hostImage(deps.filesystem, CRED_KERNEL, wasmPath);
            }
            catch (error) {
                await ctx.stderr.write(`${binName}: opening ${wasmPath}: ${error instanceof Error ? error.message : String(error)}\n`);
                return 1;
            }
            // The caller's environment, as a process's children get it.
            const env = {};
            for (const [name, value] of Object.entries(ctx.env ?? {}))
                if (typeof value === 'string')
                    env[name] = value;
            let stdio;
            try {
                stdio = openRuntimeStdio(deps, ctx, [binName, ...argv].join(' '), { takesSignals });
            }
            catch (error) {
                await ctx.stderr.write(`${binName}: ${error instanceof Error ? error.message : String(error)}\n`);
                return 1;
            }
            const warm = warmKeys.take();
            const facet = deps.facets.open({
                tag: 'wasi-cli-runner',
                concurrency: 1,
                syscalls: stdio.syscalls,
                preamble: WASI_CLI_RUNNER_PREAMBLE,
                wasmModules: { 'program.wasm': image },
                warm,
            });
            const args = { argv: [binName, ...argv], env, cwd: `/${normalizeVfsPath(cwd)}`, cred, pid: stdio.pid };
            let outcome = 1;
            try {
                let result;
                try {
                    result = await facet.submit(WASI_CLI_CALL_TASK, args, { timeoutMs: WASI_CLI_TIMEOUT_MS, signal: stdio.signal });
                }
                catch (error) {
                    // The facet may still be running, or be gone: its key is not used again.
                    if (stdio.signal.aborted)
                        return (outcome = 130);
                    await ctx.stderr.write(`${binName}: ${error instanceof Error ? error.message : String(error)}\n`);
                    return (outcome = 1);
                }
                warmKeys.give(warm, { reusable: result.reusable, error: result.error, killed: stdio.signal.aborted });
                if (result.error) {
                    await ctx.stderr.write(`${binName}: ${result.error}\n`);
                    return (outcome = result.exitCode || 1);
                }
                return (outcome = result.exitCode);
            }
            finally {
                // The call's pool and its capability go; a warm facet's isolate stays for the next run.
                facet.dispose();
                await stdio.finish(outcome);
            }
        };
    };
}
// ── Facet preamble ───────────────────────────────────────────────────
const WASI_CLI_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: wasi-cli-runner preamble ───────────────────────────────────
globalThis.__wasiCliRun = async function __wasiCliRun(args) {
  // The session root at '/'; the program starts in args.cwd (nimbus_proc.startup_dir).
  __wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: args.cred, pid: args.pid });
  // After initFS, which drops any supervisor a pooled isolate still held.
  __wasiAdoptSupervisor(args.supervisor || null);

  // The process's byte channels: its output as it writes it, its input as the caller's is pumped to it.
  const output = __wasiSupervisorOutput(args.supervisor);
  let memory = null;
  const wasi = __wasiMakeImports({
    abi: 'preview1',
    argv: args.argv,
    env: args.env,
    cwd: args.cwd,
    getMemory: () => memory,
    stdoutBytes: output.stdoutBytes,
    stderrBytes: output.stderrBytes,
    restartsWaits: true,
    takesSignals: true,
  });
  let instance;
  try {
    const r = await WebAssembly.instantiate(args.program, {
      ${WASI_ABI_NAMESPACE.preview1}: wasi.wasiImport,
      nimbus_proc: wasi.procImport,
      nimbus_fs: wasi.fsImport,
    });
    instance = r instanceof WebAssembly.Instance ? r : r.instance;
  } catch (e) {
    return { exitCode: 1, error: 'instantiate failed: ' + (e && e.message) };
  }
  memory = instance.exports.memory;
  const run = await __wasiRunStartAsync(instance, { memory });
  // A child it left running runs on without it.
  wasi.procDispose();
  const lost = await output.drain();
  // Its output's reader went away (\`jq . big.json | head\`): it dies of SIGPIPE at its next write, silently, as it does natively.
  const piped = output.brokenPipe() && !run.error;
  return {
    exitCode: piped ? 141 : run.exitCode,
    error: piped ? undefined : run.error || (lost ? 'output lost: ' + lost : undefined),
    reusable: typeof __wasiReusable === 'function' && __wasiReusable(),
  };
};
// ── END: wasi-cli-runner preamble ─────────────────────────────────────
`;
export const WASI_CLI_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${WASI_CLI_RUNNER_PREAMBLE_TAIL}`;
