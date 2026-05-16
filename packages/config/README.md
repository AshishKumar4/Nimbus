# @nimbus-sh/config

Typed, zero-dependency wrangler-config helper for Nimbus.

## Install

```bash
npm install --save-dev @nimbus-sh/config
```

## Quickstart

```ts
import { buildNimbusWranglerConfig } from '@nimbus-sh/config';
import { writeFileSync } from 'node:fs';

const config = buildNimbusWranglerConfig({
  name: 'my-nimbus',
  r2BucketPrefix: 'my-nimbus',
  runtimeCache: 'shared',          // or 'byoa'
  // legacyPublic: true,           // single-tenant mode, no JWT verify
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
| `runtimeCache` | `'shared' \| 'byoa'` | `'shared'` | Bind `NIMBUS_RUNTIME_CACHE` to the public shared bucket OR `${prefix}-runtime-cache` (BYOA). |
| `legacyPublic` | `boolean` | `false` | Adds `NIMBUS_LEGACY_PUBLIC=1` to vars (single-tenant mode). |
| `extraAliases` | `Record<string, string>` | `{}` | Extra entries merged into the alias map. |

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

## Status

v0.1. The output shape is locked against Nimbus v0.1; minor knobs may
be added without breakage.

MIT.
