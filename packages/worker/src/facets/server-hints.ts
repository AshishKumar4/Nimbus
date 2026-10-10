/**
 * server-hints.ts — which programs start as residents directly. Hints only:
 * a program that listens runs on as a resident however it started
 * (FacetManager._promote), so a hint that is missing or wrong costs time,
 * never correctness. A server it names skips the run up to its listen that
 * its first launch would otherwise make twice.
 *
 *   KNOWN_SERVER_BINS_HINT   bins that serve unless told to do something that
 *                            ends (`build`, `--version`): vite, next, astro…
 *   learned                  a program that listened, by its package, bin and
 *                            first positional argument, learned in this
 *                            workspace when it was run on as a resident.
 */

import type { ServerIdentity } from '@nimbus-sh/core/runtime/server-launch.js';

export function serverIdentityKey(identity: ServerIdentity): string {
  return `${identity.package}\u0000${identity.bin}\u0000${identity.arg0}`;
}

/** The first argument that is not an option: the subcommand, when the bin has one. */
export function firstPositional(argv: readonly string[]): string {
  return argv.find((arg) => !arg.startsWith('-')) ?? '';
}

export const KNOWN_SERVER_BINS_HINT: ReadonlySet<string> = new Set([
  'vite', 'vinext', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
  'wrangler', 'nodemon', 'tsx', 'ts-node-dev', 'webpack-dev-server',
  'parcel', 'rollup', 'esbuild', 'turbo',
]);

const NON_INTERACTIVE_ARGS: ReadonlySet<string> = new Set(['--help', '-h', 'help', '--version', '-v', 'version']);

/** An argument that asks a CLI for help or its version: it prints and ends. */
export function isNonInteractiveArg(arg: string): boolean {
  return NON_INTERACTIVE_ARGS.has(arg.trim().toLowerCase());
}

/**
 * Whether `binName argv` is a known server's serving invocation: one of the
 * known bins, unless asked for help, its version or a `build` (each ends);
 * any bin watching or serving by flag.
 */
export function knownServerBin(binName: string, argv: readonly string[]): boolean {
  if (KNOWN_SERVER_BINS_HINT.has(binName)) return !argv.some((arg) => isNonInteractiveArg(arg) || arg === 'build');
  return argv.some((arg) => arg === '--watch' || arg === '-w' || arg === '--serve' || arg === '--dev');
}

/** The storage a workspace's learned hints are kept in (its session's). */
export interface ServerHintStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const LEARNED_KEY = 'server-hints';
/** Identities kept, the least recently learned leaving first. */
export const LEARNED_SERVERS_MAX = 256;

/** The programs this workspace learned are servers, read once per isolate. */
export class LearnedServers {
  private keys: Promise<string[]> | null = null;

  constructor(private readonly storage: ServerHintStorage) {}

  private load(): Promise<string[]> {
    return this.keys ??= this.storage.get<string[]>(LEARNED_KEY).then((keys) => (Array.isArray(keys) ? keys : []));
  }

  async has(identity: ServerIdentity): Promise<boolean> {
    return (await this.load()).includes(serverIdentityKey(identity));
  }

  async learn(identity: ServerIdentity): Promise<void> {
    const key = serverIdentityKey(identity);
    const keys = (await this.load()).filter((known) => known !== key);
    keys.push(key);
    if (keys.length > LEARNED_SERVERS_MAX) keys.splice(0, keys.length - LEARNED_SERVERS_MAX);
    this.keys = Promise.resolve(keys);
    await this.storage.put(LEARNED_KEY, keys);
  }
}
