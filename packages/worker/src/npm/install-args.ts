import { parseArgs } from '@nimbus-sh/core/substrate/lifo/utils/args.js';
import { parseNpmLogLevel, type NpmLogLevel } from './npm-log.js';

export interface NpmInstallInvocation {
  packages: string[];
  global: boolean;
  prefix: string | null;
  /** `--loglevel`, when it names a level npm recognises; null otherwise. */
  loglevel: NpmLogLevel | null;
  /**
   * `--production` / `-p` / `--omit=dev`: install dependencies only.
   *
   * Both npm and bun honour this, and it is the one answer a project has to a
   * devDependency Nimbus cannot run — a headless-browser driver, a native
   * toolchain — when the thing being installed is the runtime, not the test
   * suite. The flag was in the arg spec but its value was dropped, so it
   * silently did nothing and the install failed on a package the caller had
   * already said to skip.
   */
  production: boolean;
}

const INSTALL_ARG_SPEC = {
  global: { type: 'boolean', short: 'g' },
  prefix: { type: 'string' },
  loglevel: { type: 'string' },
  registry: { type: 'string' },
  tag: { type: 'string' },
  cache: { type: 'string' },
  omit: { type: 'string' },
  include: { type: 'string' },
  workspace: { type: 'string', short: 'w' },
  'min-release-age': { type: 'string' },
  'save-prefix': { type: 'string' },
  'ignore-scripts': { type: 'boolean' },
  'no-fund': { type: 'boolean' },
  fund: { type: 'boolean' },
  'no-audit': { type: 'boolean' },
  audit: { type: 'boolean' },
  progress: { type: 'boolean' },
  save: { type: 'boolean', short: 'S' },
  'save-dev': { type: 'boolean', short: 'D' },
  'save-prod': { type: 'boolean', short: 'P' },
  'save-optional': { type: 'boolean', short: 'O' },
  'save-exact': { type: 'boolean', short: 'E' },
  'package-lock': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
  'legacy-peer-deps': { type: 'boolean' },
  workspaces: { type: 'boolean' },
  // bun spells it `-p`; npm's `-P` is --save-prod, and the short map is
  // case-sensitive, so both tools' spellings land where they should.
  production: { type: 'boolean', short: 'p' },
} as const;

export function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation {
  const parsed = parseArgs(args, INSTALL_ARG_SPEC);
  return {
    packages: parsed.positional,
    global: parsed.flags.global === true,
    prefix: stringFlag(parsed.flags.prefix),
    loglevel: parseNpmLogLevel(parsed.flags.loglevel),
    production: parsed.flags.production === true || omittedDependencyTypes(args).has('dev'),
  };
}

/**
 * Every `--omit` in the invocation. npm allows the flag more than once
 * (`--omit=dev --omit=optional`), and the generic parser keeps only the last
 * value — so the one spelling that matters would be missed whenever a caller
 * omitted more than one kind.
 */
function omittedDependencyTypes(args: string[]): Set<string> {
  const omitted = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--omit') {
      const value = args[++i];
      if (value) omitted.add(value);
    } else if (arg.startsWith('--omit=')) {
      omitted.add(arg.slice('--omit='.length));
    }
  }
  return omitted;
}

function stringFlag(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
