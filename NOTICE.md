# Notices

Nimbus is free and open source software under the MIT License. See
[`LICENSE`](LICENSE).

This project builds on Cloudflare Workers, Durable Objects, R2, Workers
Assets, and the Workers runtime surface. Self-hosted deployments are operated
by the deployer in their own Cloudflare account.

## Third-party components

Nimbus includes, wraps, or downloads third-party components. Their upstream
licenses remain in effect.

| Component | Use in Nimbus | Upstream license notes |
|---|---|---|
| `lifo-sh/lifo` `packages/core` source | Shell interpreter, command framework, core userland substrate imported under `packages/worker/src/substrate/lifo`. | MIT. |
| `@ashishkumar472/cf-git` / `isomorphic-git` fork | Cloudflare-compatible Git implementation. | MIT. |
| `esbuild` / `esbuild-wasm` | TypeScript/JS transform and bundling in Worker Loader facets. | MIT. |
| Oxc (`oxc` crates), rolldown, `@oxc-project/runtime` | The transform facet's wasm (`packages/worker/scripts/oxc-wasm`, built from Oxc, with esbuild's and @oxc-project/runtime's helpers it inlines into output), the build facet's rolldown binding. | MIT; @oxc-project/runtime's `decorate`, `decorateParam` and `decorateMetadata` are TypeScript's emit helpers, Apache-2.0. |
| `tsconfck` (dominikg), `strip-json-comments` and `strip-bom` (Sindre Sorhus) | Finding and reading a module's tsconfig for the built-in Vite dev server as Vite does; tsconfck 3.1's parse, with the JSON helpers it carries, ported to `packages/core/src/runtime/tsconfck.ts`. | MIT, Copyright (c) 2021-present dominikg and tsconfck contributors; MIT, Copyright (c) Sindre Sorhus. |
| `es-module-lexer` (Guy Bedford) | Finding `import()` and `import.meta` in Node cells; its CSP build is vendored in `packages/core/src/runtime/module-lexer.ts`. | MIT, Copyright (C) 2018-2022 Guy Bedford. |
| Node.js `lib/internal/util/inspect.js` and `lib/internal/per_context/primordials.js` (v22.22.3) | The node shims' `util.inspect`, `util.format` and console formatting: both files vendored byte for byte in `packages/worker/src/runtime/node-inspect-source.ts`, with Node internals they import ported in `packages/worker/src/runtime/node-inspect-host.ts`. | MIT, Copyright Node.js contributors. |
| Unicode Character Database `EastAsianWidth.txt` (17.0.0) | The East Asian Wide and Fullwidth ranges the node shims count two columns for, in `packages/worker/src/runtime/node-inspect-source.ts`. | Unicode License v3, Copyright © 1991-2025 Unicode, Inc. |
| `wabt` / wabt.js | Test and WASM tooling support. | Apache-2.0. |
| Cloudflare `workerd`, Wrangler, and Workers types | Local development and Worker runtime compatibility. | Apache-2.0 and/or MIT, depending on package. |
| `pip-requirements-js` | PEP 508 / requirements-file parsing for the Nimbus pip planner. | MPL-2.0. |
| `@renovatebot/pep440` | PEP 440 version/specifier matching for the Nimbus pip planner. | Apache-2.0. |
| Pyodide / CPython | Python runtime package synced into Nimbus runtime cache. | Pyodide is MPL-2.0; the distribution also contains CPython and package-level licenses. |
| `ruby.wasm` / CRuby | Ruby runtime package synced into Nimbus runtime cache. | ruby.wasm is MIT; bundled Ruby components carry their upstream notices. |
| `binji/wasm-clang`, LLVM, LLD, wasi-libc | Clang, linker, and WASI sysroot runtime packages. | Apache-2.0, Apache-2.0 WITH LLVM-exception, MIT, and LLVM project license notices. |
| Rollup WASM, Vite, React plugin tooling, npm packages | Browser preview and package/runtime support. | See each package manifest and bundled artifact notice. |

Runtime packages uploaded with `nimbus runtime sync` include manifest-level
license notes. If you redistribute those runtime blobs outside Nimbus, keep
the upstream license files and notices with the redistributed artifacts.

## Hosted alpha demo

The hosted demo at `https://nimbus-os.dev` is a public hobby
alpha for trying Nimbus. It is not a managed service, does not carry an SLA,
and should not be used to store secrets or production data. For real use,
self-host Nimbus in your own Cloudflare account.
