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
