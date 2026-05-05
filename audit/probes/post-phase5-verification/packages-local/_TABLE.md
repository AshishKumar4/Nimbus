# Post-Phase-5 local package compat — generated 2026-05-05T01:20:46.535Z

Total: 33
- ✅ 7
- ⚠️ 19
- ⛔ 7 (loud reject — counts as healthy outcome)
- ❌ 0
- ❓ 0

| Package | Status | Install | Runtime |
|---|---|---|---|
| `astro` | ⚠️ | added 230 pkgs, 8983 files | Error: Cannot load module 'home/user/app/node_modules/astro/dist/index.js': file was not pre-bundled. Add it to the VFS bundle. |
| `axios` | ✅ | added 26 pkgs, 417 files | keys: ["constructor","request","_request","getUri","delete","get","head","options"] |
| `bcrypt` | ⛔ | ❌ bcrypt — Native bcrypt; pure-JS bcryptjs has identical sync API but the require() name differs and Nimbus does not yet support `npm:` aliases. | Error: Cannot find module 'bcrypt' (from /home/user/app) |
| `better-sqlite3` | ⛔ | ❌ better-sqlite3 — Native sqlite .node binding. | Error: Cannot find module 'better-sqlite3' (from /home/user/app) |
| `drizzle-orm` | ✅ | added 1 pkgs, 2666 files | keys: ["ColumnAliasProxyHandler","RelationTableAliasProxyHandler","TableAliasProxyHandler","aliasedRelation","aliasedTable","aliasedTableColumn","mapColumnsInAliasedSQLToAlias","mapColumnsInSQLToAlias |
| `express` | ⚠️ | added 68 pkgs, 628 files | Error: Object prototype may only be an Object or null: undefined |
| `fastify` | ⚠️ | added 46 pkgs, 1928 files | Error: Cannot read module: home/user/app/node_modules/ret/dist/types |
| `framer-motion` | ⚠️ | added 4 pkgs, 907 files | Error: Cannot find module 'react/jsx-runtime' (from home/user/app/node_modules/framer-motion/dist/cjs) |
| `fsevents` | ⛔ | ❌ fsevents — macOS-only filesystem watcher; never runs in Workers. | Error: Cannot find module 'fsevents' (from /home/user/app) |
| `jest` | ✅ | added 236 pkgs, 4823 files | typeof: object |
| `jsdom` | ⚠️ | added 39 pkgs, 1800 files | Error: Cannot load module 'home/user/app/node_modules/tldts/dist/es6/index.js': file was not pre-bundled. Add it to the VFS bundle. |
| `next` | ⚠️ | added 8 pkgs, 9374 files | Error: Cannot read properties of undefined (reading 'require') |
| `node-canvas` | ⛔ | ❌ canvas — Native Cairo bindings. | Error: Cannot find module 'canvas' (from /home/user/app) |
| `nuxt` | ⚠️ | added 428 pkgs, 10814 files | Error: Cannot find module 'nuxt' (from /home/user/app) |
| `parcel` | ⚠️ | added 0 pkgs, 0 files | Error: Cannot find module 'parcel' (from /home/user/app) |
| `pg` | ✅ | added 14 pkgs, 141 files | keys: ["defaults","Client","Query","Pool","_pools","Connection"] |
| `prisma` | ⛔ | ❌ prisma — Native query engine; not portable to Workers in this configuration. | Error: Cannot find module 'prisma' (from /home/user/app) |
| `puppeteer-core` | ✅ | added 78 pkgs, 4066 files | keys: ["connect","defaultArgs","executablePath","launch","WEB_PERMISSION_TO_PROTOCOL_PERMISSION","Browser","BrowserContext","CDPSessionEvent"] |
| `radix-react-dialog` | ⚠️ | added 26 pkgs, 430 files | Error: Cannot find module 'react' (from home/user/app/node_modules/@radix-ui/react-dialog/dist) |
| `react-remove-scroll` | ⚠️ | added 8 pkgs, 272 files | Error: Cannot load module 'home/user/app/node_modules/react-remove-scroll/dist/es2015/index.js': file was not pre-bundled. Add it to the VFS bundle. |
| `redis` | ⚠️ | added 7 pkgs, 2371 files | Error: Cannot read module: home/user/app/node_modules/@redis/client/dist/lib/client |
| `remix-react` | ⚠️ | added 10 pkgs, 269 files | Error: Cannot load module 'home/user/app/node_modules/@remix-run/react/dist/esm/index.js': file was not pre-bundled. Add it to the VFS bundle. |
| `rollup` | ⚠️ | added 0 pkgs, 0 files | Error: Cannot find module 'rollup' (from /home/user/app) |
| `sharp` | ⛔ | ❌ sharp — Native libvips bindings; not portable to Workers. | Error: Cannot find module 'sharp' (from /home/user/app) |
| `swc-core` | ⛔ | ❌ @swc/core — Native Rust SWC. | Error: Cannot find module '@swc/core' (from /home/user/app) |
| `tailwindcss-oxide` | ⚠️ | added 1 pkgs, 4 files | Error: Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory. |
| `tailwindcss-vite` | ⚠️ | added 16 pkgs, 317 files | Error: Cannot load module 'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs': file was not pre-bundled. Add it to the VFS bundle. |
| `ts-jest` | ⚠️ | added 15 pkgs, 711 files | Error: Cannot find module 'typescript' (from home/user/app/node_modules/ts-jest/dist/legacy) |
| `ts-node` | ✅ | added 17 pkgs, 268 files | typeof: object |
| `vite` | ⚠️ | added 9 pkgs, 150 files | Error: Cannot load module 'home/user/app/node_modules/vite/dist/node/index.js': file was not pre-bundled. Add it to the VFS bundle. |
| `vitest` | ⚠️ | added 34 pkgs, 530 files | Error: Vitest cannot be imported in a CommonJS module using require(). Please use "import" instead. |
| `webpack` | ⚠️ | added 0 pkgs, 0 files | Error: Cannot find module 'webpack' (from /home/user/app) |
| `zod` | ✅ | added 1 pkgs, 718 files | parse: hi |
