#!/usr/bin/env node
/**
 * bin/nimbus — Multi-verb CLI dispatcher.
 *
 * Usage:
 *   nimbus token mint  --tenant acme --sub alice [--ttl 3600]
 *   nimbus token verify <token>
 *   nimbus runtime sync                 # populates user's R2 bucket
 *   nimbus runtime list                 # show staged runtimes
 *   nimbus session new                  # mint a session via /new
 *   nimbus --version
 *   nimbus --help
 *
 * Design notes:
 *   - Zero dependencies on commander/yargs. The verb table is ~50 LOC.
 *     This keeps the install footprint tiny (matters for `npx`).
 *   - Every verb writes JSON to stdout on success (machine-parseable),
 *     a human-readable summary line to stderr, and exits 0. Failures
 *     emit JSON `{ error, code }` + exit code from CLI_EXIT_CODES.
 */

import { mintToken, verifyTokenCmd } from './commands/token.js';
import { syncRuntimes, listRuntimes } from './commands/runtime-sync.js';
import { newSession } from './commands/session.js';
import { CLI_VERSION } from './version.js';

type Verb = (args: string[]) => Promise<number>;

const verbs: Record<string, Record<string, Verb>> = {
  token: {
    mint: mintToken,
    verify: verifyTokenCmd,
  },
  runtime: {
    sync: syncRuntimes,
    list: listRuntimes,
  },
  session: {
    new: newSession,
  },
};

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  const [namespace, verb, ...rest] = argv;
  if (!verbs[namespace] || !verbs[namespace][verb]) {
    process.stderr.write(`nimbus: unknown command \`${namespace} ${verb || ''}\`. Try \`nimbus --help\`.\n`);
    return 64;
  }
  return verbs[namespace][verb](rest);
}

function printHelp(): void {
  process.stdout.write(`nimbus ${CLI_VERSION}

Usage:
  nimbus token mint   --tenant <t> [--sub <s>] [--ttl <sec>] [--scopes <a,b>]
  nimbus token verify <token>
  nimbus runtime sync [--bucket <name>]
  nimbus runtime list
  nimbus session new [--endpoint <url>]

For embedder scaffolding:
  npx create-nimbus-app <project-name>

Env:
  JWT_SECRET        Shared secret for HS256 (required for token mint/verify).
  NIMBUS_ENDPOINT   Base URL for session new. Defaults to localhost:8787.
  CLOUDFLARE_ACCOUNT_ID  Required for runtime sync.
`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`nimbus: ${err?.stack || err}\n`);
    process.exit(70);
  },
);
