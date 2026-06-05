#!/usr/bin/env node
/**
 * bin/nimbus — Multi-verb CLI dispatcher.
 *
 * Usage:
 *   nimbus token mint  --tenant acme --sub alice [--ttl 3600]
 *   nimbus token verify <token>
 *   nimbus runtime sync                 # upload runtime blobs/catalog through CLI wrapper
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
import { setupCloudflare } from './commands/setup.js';
import { CLI_VERSION } from './version.js';
const verbs = {
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
    setup: {
        cloudflare: setupCloudflare,
    },
};
async function main(argv) {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printHelp();
        return 0;
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
        process.stdout.write(`${CLI_VERSION}\n`);
        return 0;
    }
    if (argv[0] === 'init') {
        const { scaffold } = await import('./commands/scaffold.js');
        return scaffold(argv.slice(1).length > 0 ? argv.slice(1) : ['.']);
    }
    const [namespace, verb, ...rest] = argv;
    if (!verbs[namespace] || !verbs[namespace][verb]) {
        process.stderr.write(`nimbus: unknown command \`${namespace} ${verb || ''}\`. Try \`nimbus --help\`.\n`);
        return 64;
    }
    return verbs[namespace][verb](rest);
}
function printHelp() {
    process.stdout.write(`nimbus ${CLI_VERSION}

Usage:
  nimbus token mint   --tenant <t> [--sub <s>] [--ttl <sec>] [--scopes <a,b>]
  nimbus token verify <token>
  nimbus runtime sync [--bucket <name>] [runtime[@version]...]
  nimbus runtime list
  nimbus session new [--endpoint <url>]
  nimbus setup cloudflare --name <worker-name>
  nimbus init [directory]

For embedder scaffolding:
  create-nimbus-app <project-name>

Env:
  JWT_SECRET        Shared secret for HS256 (required for token mint/verify).
  NIMBUS_ENDPOINT   Base URL for session new. Defaults to localhost:8787.
  CLOUDFLARE_ACCOUNT_ID  Required for runtime sync.
`);
}
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`nimbus: ${err?.stack || err}\n`);
    process.exit(70);
});
