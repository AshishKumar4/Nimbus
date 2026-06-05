# @nimbus-sh/config

Typed, zero-dependency Wrangler config helper for Nimbus.

## Install

```bash
npm install --save-dev @nimbus-sh/config
```

## Quickstart

```ts
import { buildNimbusWranglerConfig, defineNimbusConfig } from '@nimbus-sh/config';
import { writeFileSync } from 'node:fs';

export const nimbusConfig = defineNimbusConfig({
  endpoint: 'https://my-nimbus.workers.dev',
  runtimeCache: { mode: 'shared' },
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: {
        preinstall: ['python'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
    },
  },
});

const config = buildNimbusWranglerConfig({
  name: 'my-nimbus',
  r2BucketPrefix: 'my-nimbus',
  runtimeCache: 'shared',          // or 'byoa' / { mode, bucket }
  // legacyPublic: true,           // single-tenant mode, no JWT verify
  agent: {
    model: '@cf/moonshotai/kimi-k2.6',
    gatewayId: 'default',
    oauth: {
      clientId: '<oauth-client-id>',
      scopes: ['<scope-id-1>', '<scope-id-2>'],
      redirectUri: 'https://my-nimbus.workers.dev/api/nimbus/oauth/callback',
    },
    owner: {
      accountId: '<cloudflare-account-id>',
    },
  },
});

writeFileSync('wrangler.jsonc', JSON.stringify(config, null, 2));
```

## Options

| Option | Type | Default | What |
|---|---|---|---|
| `name` | `string` | (required) | Worker name + R2 bucket prefix. |
| `compatibilityDate` | `string` | `'2026-04-01'` | Wrangler compat date. |
| `placement` | `'smart' \| undefined` | `'smart'` | Cloudflare Smart Placement. |
| `r2BucketPrefix` | `string` | `name` | Prefix for `${prefix}-npm-cache`, etc. |
| `runtimeCache` | `'shared' \| 'byoa' \| { mode, bucket? }` | `'shared'` | Bind `NIMBUS_RUNTIME_CACHE` to the standard account-local bucket `nimbus-runtime-cache-public`, `${prefix}-runtime-cache`, or an explicit bucket. Seed the bucket with `nimbus setup cloudflare` or `nimbus runtime sync`. |
| `legacyPublic` | `boolean` | `false` | Adds `NIMBUS_LEGACY_PUBLIC=1` to vars (single-tenant mode). |
| `extraAliases` | `Record<string, string>` | `{}` | Extra entries merged into the alias map. |
| `agent` | `object` | unset | Emits non-secret Agent vars for Cloudflare OAuth, Workers AI model, AI Gateway, and owner-account fallback. |

Agent secrets are never written by this package. Store them with Wrangler:

```bash
npx wrangler secret put NIMBUS_AGENT_COOKIE_SECRET
npx wrangler secret put NIMBUS_CLOUDFLARE_API_TOKEN
```

## Why use this over hand-written wrangler.jsonc?

1. **Forwards-compat**: if Nimbus adds a required binding in v0.2,
   this package updates and your `wrangler.jsonc` regenerates cleanly.
2. **Alias map**: 12 alias entries are required for `isomorphic-git`
   and the npm installer to work. Easy to copy-paste-drift. This
   helper exports them as `NIMBUS_REQUIRED_ALIASES`.
3. **Programmatic**: usable from Pulumi/Terraform/CDK or any custom CI.

```ts
import { NIMBUS_REQUIRED_ALIASES } from '@nimbus-sh/config';
// → { 'clean-git-ref': '...', 'sha.js': 'sha.js', ... }
```

## Sandbox profiles

`defineNimbusConfig()` is a typed identity helper for SDK/runtime policy. It
does not write files and does not affect Wrangler output by itself; pass the
returned object to `Nimbus.fromEnv(env, nimbusConfig)`,
`Nimbus.connect({ config: nimbusConfig, ... })`, and
`createNimbusHandler({ sdk: { remote: true, config: nimbusConfig } })`.

```ts
const nimbusConfig = defineNimbusConfig({
  endpoint: 'https://my-nimbus.workers.dev',
  sandboxes: {
    proteus: {
      root: '/home/user',
      tools: { namespace: 'sandbox', kind: 'sandbox' },
      runtimes: {
        preinstall: ['python', 'clang'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
      preview: { baseUrl: 'https://my-nimbus.workers.dev/s/{sessionId}' },
    },
  },
});
```

`preinstall` is applied by `box.ready()`. `onDemand: false` blocks SDK runtime
installs for runtimes not in `preinstall`; `allow` controls which runtime
operations the SDK advertises and permits.

## Status

v0.1. The output shape is locked against Nimbus v0.1; minor knobs may
be added without breakage.

MIT.
