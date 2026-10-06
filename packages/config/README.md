# @nimbus-sh/config

Generate the `wrangler.jsonc` a Nimbus Worker needs.

The helper writes the bindings, the R2 buckets, the alias map, and the
non-secret agent vars. It is typed and has no dependencies.

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
  runtimeCatalogSha256: '<64 hex>', // what `nimbus runtime sync` printed
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
| `compatibilityDate` | `string` | `'2026-09-26'` | Wrangler compat date. An older date is kept, and the config lists each flag Nimbus needs that it does not enable: `enhanced_error_serialization` before 2026-04-21, `nodejs_compat` before 2026-08-04. |
| `placement` | `'smart' \| undefined` | `'smart'` | Cloudflare Smart Placement. |
| `r2BucketPrefix` | `string` | `name` | Prefix for `${prefix}-npm-cache`, etc. |
| `runtimeCache` | `'shared' \| 'byoa' \| { mode, bucket? }` | `'shared'` | Bind `NIMBUS_RUNTIME_CACHE` to the standard account-local bucket `nimbus-runtime-cache-public`, `${prefix}-runtime-cache`, or an explicit bucket. Seed the bucket with `nimbus setup cloudflare` or `nimbus runtime sync`. |
| `runtimeCatalogSha256` | `string` | unset | The digest `nimbus runtime sync` printed for the runtime cache bucket, carried as the `NIMBUS_RUNTIME_CATALOG_SHA256` var. `nimbus install` reads the catalog by it; without it every install fails, saying so. |
| `legacyPublic` | `boolean` | `false` | Adds `NIMBUS_LEGACY_PUBLIC=1` to vars (single-tenant mode). |
| `extraAliases` | `Record<string, string>` | `{}` | Extra entries merged into the alias map. |
| `agent` | `object` | unset | Emits non-secret Agent vars for Cloudflare OAuth, Workers AI model, AI Gateway, and owner-account fallback. |

The helper never writes agent secrets. Store those with Wrangler:

```bash
npx wrangler secret put NIMBUS_AGENT_COOKIE_SECRET
npx wrangler secret put NIMBUS_CLOUDFLARE_API_TOKEN
```

## Why generate the config

1. **Forwards-compat**: if Nimbus adds a required binding in v0.2, this
   package updates and your `wrangler.jsonc` regenerates cleanly.
2. **Alias map**: `isomorphic-git` and the npm installer need 12 alias
   entries. Copied by hand they drift. The helper exports them as
   `NIMBUS_REQUIRED_ALIASES`.
3. **Programmatic**: it runs from Pulumi, Terraform, CDK, or any custom CI.

```ts
import { NIMBUS_REQUIRED_ALIASES } from '@nimbus-sh/config';
// → { 'clean-git-ref': '...', 'sha.js': 'sha.js', ... }
```

## Sandbox profiles

`defineNimbusConfig()` is a typed identity helper for SDK/runtime policy. It
does not write files and does not affect Wrangler output by itself. Pass the
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
