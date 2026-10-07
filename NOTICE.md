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
| Unicode Character Database `EastAsianWidth.txt` (17.0.0) | The East Asian Wide and Fullwidth ranges the node shims count two columns for, in `packages/worker/src/runtime/node-inspect-source.ts`. | Unicode License v3 (full text under "Unicode License v3" below), Copyright © 1991-2025 Unicode, Inc. |
| `minimatch` (Isaac Z. Schlueter), with `brace-expansion` and `balanced-match`; Node.js's `lib/internal/fs/glob.js` | The node shims' `fs.glob`: minimatch 10.2.4 vendored as Node v22.22.3 bundles it, in `packages/worker/src/runtime/node-minimatch-source.ts`, and Node's Glob ported into `packages/worker/src/runtime/node-shims.ts`. | minimatch Blue Oak Model License 1.0.0 (<https://blueoakcouncil.org/license/1.0.0>), Copyright Isaac Z. Schlueter and Contributors; brace-expansion and balanced-match MIT, Copyright (c) 2013 Julian Gruber; Node.js MIT, Copyright Node.js contributors. |
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

## Unicode License v3

The Unicode data vendored in `packages/worker/src/runtime/node-inspect-source.ts`
(from `https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt`) is
provided under this license (`https://www.unicode.org/license.txt`):

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## Hosted alpha demo

The hosted demo at `https://nimbus-os.dev` is a public hobby
alpha for trying Nimbus. It is not a managed service, does not carry an SLA,
and should not be used to store secrets or production data. For real use,
self-host Nimbus in your own Cloudflare account.
