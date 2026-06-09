import { parseArgs } from '../substrate/lifo/utils/args.js';

export interface NpmInstallInvocation {
  packages: string[];
  global: boolean;
  prefix: string | null;
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
} as const;

export function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation {
  const parsed = parseArgs(args, INSTALL_ARG_SPEC);
  return {
    packages: parsed.positional,
    global: parsed.flags.global === true,
    prefix: stringFlag(parsed.flags.prefix),
  };
}

function stringFlag(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
