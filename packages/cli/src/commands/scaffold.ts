/**
 * cli/commands/scaffold — `create-nimbus-app <project-name>`.
 *
 * v0.1 ships a single template: `worker-only`. The scaffolder writes:
 *
 *   <project>/
 *   ├── package.json       — deps: @nimbus-sh/sdk, @nimbus-sh/worker
 *   ├── wrangler.jsonc     — the canonical 28-LOC embedder snippet
 *   ├── src/
 *   │   └── index.ts       — 6 LOC default-export
 *   ├── README.md          — install + deploy instructions
 *   └── .gitignore         — node_modules, .wrangler
 *
 * The scaffolder does NOT call `wrangler login`, `wrangler secret put`,
 * or `wrangler deploy` — those are interactive and operator-owned. We
 * print the exact commands to run as a "next steps" trailer.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';

/**
 * Scaffold a new Nimbus project at the given directory.
 *
 * @param args Argv: `[project-name, ...flags]`. Flags:
 *               `--template worker-only` (default)
 *               `--name <wrangler-name>` (default: project-name)
 *               `--force` overwrite existing files.
 */
export async function scaffold(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`create-nimbus-app

Usage:
  create-nimbus-app <project-name> [--name <worker-name>] [--force]
  create-nimbus-app . --name <worker-name>

Options:
  --name <worker-name>  Deployed Cloudflare Worker name. Defaults to project name.
  --template <name>     Template to use. Only worker-only ships in v0.1.
  --force               Overwrite existing files.
`);
    return 0;
  }

  const rawProjectName = args[0];
  if (!rawProjectName || rawProjectName.startsWith('-')) {
    process.stderr.write('create-nimbus-app: <project-name> required\n');
    process.stderr.write('Usage: create-nimbus-app my-app [--name my-worker] [--force]\n');
    return 64;
  }
  const parsed = parseFlags(args.slice(1));
  const target = rawProjectName === '.'
    ? process.cwd()
    : resolve(process.cwd(), rawProjectName);
  const projectName = basename(target);
  const wranglerName = parsed['--name'] || projectName;
  const force = '--force' in parsed;
  const template = parsed['--template'] || 'worker-only';

  if (template !== 'worker-only') {
    process.stderr.write(`create-nimbus-app: unknown template "${template}". Only "worker-only" ships in v0.1.\n`);
    return 64;
  }

  if (existsSync(target) && !force) {
    process.stderr.write(`create-nimbus-app: directory exists: ${target} (use --force to overwrite)\n`);
    return 73;
  }

  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, 'src'), { recursive: true });

  writeFileSync(join(target, 'package.json'), renderPackageJson(projectName));
  writeFileSync(join(target, 'wrangler.jsonc'), renderWranglerJsonc(wranglerName));
  writeFileSync(join(target, 'src', 'index.ts'), renderIndexTs());
  writeFileSync(join(target, 'README.md'), renderReadme(projectName, wranglerName));
  writeFileSync(join(target, '.gitignore'), '.wrangler\nnode_modules\ndist\n');
  writeFileSync(join(target, 'tsconfig.json'), renderTsconfig());

  const cdTarget = renderCdTarget(target);

  // Stdout — JSON for machine, friendly stderr for humans.
  process.stdout.write(
    JSON.stringify({
      ok: true,
      path: target,
      nextSteps: [
        `cd ${cdTarget}`,
        'npm install',
        `CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name ${wranglerName}`,
        'npx wrangler secret put JWT_SECRET',
        'npx wrangler deploy',
      ],
    }) + '\n',
  );
  process.stderr.write(`
✨ Scaffolded ${projectName} at ${target}

Next steps:
  cd ${cdTarget}
  npm install
  CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name ${wranglerName}
  npx wrangler secret put JWT_SECRET       # paste a 32+ char hex secret
  npx wrangler deploy

If setup reports Cloudflare R2 error 10042, enable R2 in the Cloudflare
Dashboard once for this account, then rerun the setup command.

Deploy will provision the Durable Object on first use. Mint a token with
\`nimbus token mint\` before attaching an interactive session or remote SDK
sandbox.

Docs: https://github.com/AshishKumar4/Nimbus#readme
`);
  return 0;
}

// ── template renderers ──────────────────────────────────────────────

function renderCdTarget(target: string): string {
  const rel = relative(process.cwd(), target);
  if (!rel) return '.';
  if (!rel.startsWith('..') && !rel.startsWith('/')) return rel;
  return target;
}

function renderPackageJson(name: string): string {
  return JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'wrangler dev --ip 0.0.0.0 --port 8787',
        deploy: 'wrangler deploy',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        '@nimbus-sh/config': '^0.1.3',
        '@nimbus-sh/worker': '^0.1.4',
        '@nimbus-sh/sdk': '^0.1.4',
      },
      devDependencies: {
        '@cloudflare/workers-types': '^4.20250327.0',
        typescript: '^5.7.0',
        wrangler: '^4.0.0',
      },
    },
    null,
    2,
  ) + '\n';
}

function renderWranglerJsonc(name: string): string {
  return `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "placement": { "mode": "smart" },
  "vars": {
    "NIMBUS_AGENT_MODEL": "@cf/moonshotai/kimi-k2.6",
    "NIMBUS_AGENT_GATEWAY_ID": "default"
  },

  "assets": {
    "directory": "node_modules/@nimbus-sh/worker/public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/s/*", "/new"]
  },

  // The Node-compat shims isomorphic-git + the npm installer need. Do
  // not omit any of these — \`git clone\` will fail at runtime if any
  // are missing.
  "alias": {
    "clean-git-ref": "clean-git-ref/lib/index.js",
    "is-git-ref-name-valid": "is-git-ref-name-valid/index.js",
    "crc-32": "crc-32",
    "sha.js": "sha.js",
    "pako": "pako",
    "pify": "pify",
    "diff": "diff",
    "diff3": "diff3",
    "ignore": "ignore",
    "readable-stream": "readable-stream",
    "simple-get": "simple-get",
    "minimisted": "minimisted"
  },

  "durable_objects": {
    "bindings": [{ "name": "NIMBUS_SESSION", "class_name": "NimbusSession" }]
  },
  "migrations": [
    { "tag": "nimbus-v1", "new_sqlite_classes": ["NimbusSession"] }
  ],

  "worker_loaders": [{ "binding": "LOADER" }],

  "r2_buckets": [
    { "binding": "NPM_TARBALL_CACHE",    "bucket_name": "${name}-npm-cache" },
    { "binding": "NPM_PACKUMENT_CACHE",  "bucket_name": "${name}-npm-packument-cache" },
    { "binding": "NIMBUS_RUNTIME_CACHE", "bucket_name": "nimbus-runtime-cache-public" }
  ]
}
`;
}

function renderIndexTs(): string {
  return `import {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
  createNimbusHandler,
} from '@nimbus-sh/sdk/worker';
import { defineNimbusConfig } from '@nimbus-sh/config';

// Re-export the DO class + every RPC class so wrangler's
// \`durable_objects.bindings[].class_name\` lookup + \`enable_ctx_exports\`
// auto-populate loopback bindings (env.SUPERVISOR, etc.).
export {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
};

const nimbusConfig = defineNimbusConfig({
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: {
        preinstall: ['python'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
      tools: { namespace: 'sandbox', kind: 'sandbox' },
    },
  },
});

export default createNimbusHandler({
  sdk: {
    remote: true,
    config: nimbusConfig,
  },
});
`;
}

function renderTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        lib: ['ES2022'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ) + '\n';
}

function renderReadme(name: string, wranglerName: string): string {
  return `# ${name}

A Nimbus-powered Cloudflare Worker.

## Setup

\`\`\`bash
npm install
CLOUDFLARE_ACCOUNT_ID=<account-id> npx @nimbus-sh/cli setup cloudflare --name ${wranglerName}
npx wrangler secret put JWT_SECRET      # paste a 32+ char hex secret
npx wrangler deploy
\`\`\`

Then visit the URL wrangler prints.

If setup reports Cloudflare R2 error 10042, enable R2 in the Cloudflare
Dashboard once for this account, then rerun the setup command.

## Session Agent

The session UI includes an Agent surface inside the editor workspace. It can
use the same sandbox tools as the terminal: shell exec, files, runtime
installs, processes, logs, and preview ports.

For user-owned Cloudflare Workers AI quota, create a Cloudflare OAuth client:

- Client Name: Nimbus Agent
- Response Type: Code
- Grant type: Authorization Code
- Token Authentication Method: None

Use this redirect URL:

\`\`\`
https://${wranglerName}.your-account.workers.dev/api/nimbus/oauth/callback
\`\`\`

Set the non-secret values in \`wrangler.jsonc\`:

\`\`\`jsonc
"vars": {
  "NIMBUS_CF_OAUTH_CLIENT_ID": "<oauth-client-id>",
  "NIMBUS_CF_OAUTH_SCOPES": "<scope-id-1> <scope-id-2>",
  "NIMBUS_AGENT_MODEL": "@cf/moonshotai/kimi-k2.6",
  "NIMBUS_AGENT_GATEWAY_ID": "default"
}
\`\`\`

Then store a 32+ character cookie encryption secret. Nimbus uses this to keep
Cloudflare OAuth tokens in encrypted HttpOnly browser cookies instead of
Durable Object storage:

\`\`\`bash
npx wrangler secret put NIMBUS_AGENT_COOKIE_SECRET
\`\`\`

For owner-token fallback, set \`NIMBUS_CLOUDFLARE_ACCOUNT_ID\` in
\`wrangler.jsonc\` and store \`NIMBUS_CLOUDFLARE_API_TOKEN\` with
\`wrangler secret put\`.

## Tokens

By default tokens are enforced because \`JWT_SECRET\` is set. Mint a token for
an interactive session or remote SDK sandbox:

\`\`\`bash
JWT_SECRET=<your-secret> npx @nimbus-sh/cli token mint \\
  --tenant acme \\
  --sub alice \\
  --scopes sandbox:use \\
  --sid job-123
\`\`\`

Use the token with \`@nimbus-sh/react\`, \`sessionAttachUrl(...)\`, or
\`Nimbus.connect({ endpoint, token })\`.

Embed in a React app:

\`\`\`tsx
import { NimbusTerminal } from '@nimbus-sh/react';

<NimbusTerminal
  endpoint="https://${wranglerName}.your-account.workers.dev"
  token={jwt}
  tenant="acme"
  sub="alice"
/>
\`\`\`

## Customize

In \`src/index.ts\`, keep the generated exports and \`nimbusConfig\`, then
replace the \`export default\` block:

\`\`\`ts
import { issueNimbusToken } from '@nimbus-sh/sdk/token';

export default createNimbusHandler({
  sdk: {
    remote: true,
    config: nimbusConfig,
  },
  hooks: {
    onSessionStart: ({ sessionId, tenantSegment }) => {
      console.log(\`session \${sessionId} for \${tenantSegment}\`);
    },
  },
  routes: async (req, env) => {
    if (new URL(req.url).pathname === '/api/auth/mint') {
      // Authenticate your application user before minting.
      const { tenant, sub } = await req.json();
      const token = await issueNimbusToken(env, {
        tn: tenant,
        sub,
        scopes: ['sandbox:use'],
      });
      return Response.json({ token });
    }
    return null;
  },
});
\`\`\`

Docs: https://github.com/AshishKumar4/Nimbus
`;
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      out[a] = args[i + 1];
      i++;
    } else {
      out[a] = '';
    }
  }
  return out;
}
