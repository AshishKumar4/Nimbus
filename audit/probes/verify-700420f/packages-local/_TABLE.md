# verify-700420f local package compat — generated 2026-05-05T21:43:55.439Z

Total: 33
- ✅ 12
- ⚠️ 10
- ⛔ 11 (loud reject — counts as healthy outcome)
- ❌ 0
- ❓ 0

| Package | Status | Install | Runtime |
|---|---|---|---|
| `astro` | ⛔ | npm install rejected: sharp — Native libvips bindings; not portable to Workers. | Error: Cannot find module 'astro' (from /home/user/app) |
| `axios` | ✅ | added 26 pkgs, 417 files | keys: ["constructor","request","_request","getUri","delete","get","head","options"] |
| `bcrypt` | ⛔ | ❌ bcrypt — Native bcrypt; pure-JS bcryptjs has identical sync API but the require() name differs and Nimbus does not yet support `npm:` aliases (W6.6). | Error: Cannot find module 'bcrypt' (from /home/user/app) |
| `better-sqlite3` | ⛔ | ❌ better-sqlite3 — Native sqlite .node binding. | Error: Cannot find module 'better-sqlite3' (from /home/user/app) |
| `drizzle-orm` | ✅ | added 608 pkgs, 29920 files | keys: ["ColumnAliasProxyHandler","RelationTableAliasProxyHandler","TableAliasProxyHandler","aliasedRelation","aliasedTable","aliasedTableColumn","mapColumnsInAliasedSQLToAlias","mapColumnsInSQLToAlias |
| `express` | ⚠️ | added 68 pkgs, 628 files | Error: Object prototype may only be an Object or null: undefined |
| `fastify` | ⚠️ | added 46 pkgs, 1930 files | Error: Cannot read properties of undefined (reading 'start') |
| `framer-motion` | ✅ | added 9 pkgs, 1020 files | keys: ["LayoutGroupContext","MotionConfigContext","MotionContext","PresenceContext","SwitchLayoutGroupContext","addPointerEvent","addPointerInfo","animations"] |
| `fsevents` | ⛔ | ❌ fsevents — macOS-only filesystem watcher; never runs in Workers. | Error: Cannot find module 'fsevents' (from /home/user/app) |
| `jest` | ✅ | added 243 pkgs, 4957 files | typeof: object |
| `jsdom` | ⚠️ | added 39 pkgs, 1800 files | Error: Cannot load module 'home/user/app/node_modules/@csstools/css-tokenizer/dist/index.mjs': pre-compile failed at facet startup: Unexpected token 'export' |
| `next` | ⛔ | npm install rejected: sharp — Native libvips bindings; not portable to Workers. | Error: Cannot find module 'next' (from /home/user/app) |
| `node-canvas` | ⛔ | ❌ canvas — Native Cairo bindings. | Error: Cannot find module 'canvas' (from /home/user/app) |
| `nuxt` | ⚠️ | added 526 pkgs, 15630 files | Error: Cannot find module '../dist/defu.cjs' (from home/user/app/node_modules/defu/lib) |
| `parcel` | ⛔ | npm install rejected: @swc/core — Native Rust SWC. | Error: Cannot find module 'parcel' (from /home/user/app) |
| `pg` | ✅ | added 19 pkgs, 253 files | keys: ["defaults","Client","Query","Pool","_pools","Connection"] |
| `prisma` | ⛔ | ❌ prisma — Native query engine; not portable to Workers in this configuration. | Error: Cannot find module 'prisma' (from /home/user/app) |
| `puppeteer-core` | ✅ | added 78 pkgs, 4066 files | keys: ["connect","defaultArgs","executablePath","launch","WEB_PERMISSION_TO_PROTOCOL_PERMISSION","Browser","BrowserContext","CDPSessionEvent"] |
| `radix-react-dialog` | ✅ | added 32 pkgs, 553 files | keys: ["Close","Content","Description","Dialog","DialogClose","DialogContent","DialogDescription","DialogOverlay"] |
| `react-remove-scroll` | ✅ | added 11 pkgs, 320 files | keys: ["RemoveScroll"] |
| `redis` | ⚠️ | added 7 pkgs, 2371 files | Error: Class extends value undefined is not a constructor or null |
| `remix-react` | ✅ | added 16 pkgs, 483 files | keys: ["Await","Form","Link","Links","LiveReload","Meta","NavLink","Navigate"] |
| `rollup` | ⚠️ | added 1 pkgs, 28 files | Error: Cannot find module 'rollup' (from /home/user/app) |
| `sharp` | ⛔ | ❌ sharp — Native libvips bindings; not portable to Workers. | Error: Cannot find module 'sharp' (from /home/user/app) |
| `swc-core` | ⛔ | ❌ @swc/core — Native Rust SWC. | Error: Cannot find module '@swc/core' (from /home/user/app) |
| `tailwindcss-oxide` | ⚠️ | added 1 pkgs, 4 files | Error: Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory. |
| `tailwindcss-vite` | ⚠️ | added 232 pkgs, 7506 files | Error: Cannot load module 'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs': pre-compile failed at facet startup: Cannot use import statement outside a module |
| `ts-jest` | ⚠️ | added 255 pkgs, 5590 files | Error: Cannot read properties of undefined (reading 'native') |
| `ts-node` | ✅ | added 21 pkgs, 548 files | typeof: object |
| `vite` | ⚠️ | added 227 pkgs, 7412 files | Error: ENOENT: no such file or directory, open 'file:///package.json' |
| `vitest` | ⛔ | npm install rejected: playwright — Bundled browsers (~300 MB). | Error: Cannot find module 'vitest' (from /home/user/app) |
| `webpack` | ✅ | added 66 pkgs, 3092 files | typeof: function |
| `zod` | ✅ | added 1 pkgs, 718 files | parse: hi |
