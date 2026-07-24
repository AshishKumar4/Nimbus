# Contributing

Nimbus is a hobby alpha. Contributions are welcome, but the project favors
small, concrete changes backed by real behavior over broad rewrites.

## Development

```bash
git clone https://github.com/AshishKumar4/Nimbus.git
cd Nimbus
bun install
bun run typecheck
bun run dev
```

The monorepo uses Bun workspaces. Use `bun install` and keep `bun.lock`
updated when dependencies change.

## Source of truth

Treat the running code as source of truth. Docs can lag. Before changing a
feature, inspect the relevant implementation under:

- `apps/hosted-demo/` for the live hosted Worker.
- `packages/worker/src/` for Durable Object, VFS, shell, runtime, npm, git,
  and route behavior.
- `packages/sdk/src/` for the public SDK.
- `tests/behavioral/` for black-box expectations.

## Pull requests

Keep PRs narrow:

- Explain the user-visible behavior being changed.
- Add or update behavioral probes when behavior changes.
- Run `bun run typecheck`.
- For SDK or live-route changes, run the relevant live probes against a
  deployed Worker before merging.

Avoid unrelated refactors. Avoid changing runtime bootstrap code unless the PR
is specifically about runtime packaging, Python, Ruby, clang, WASI, or Worker
Loader behavior.

## Behavioral probes

The behavioral suite drives real Nimbus sessions through HTTP and WebSocket.
Good probes assert observable behavior, not just status codes or static HTML.

```bash
BASE=https://nimbus-os.dev bun test:behavioral
BASE=https://nimbus-os.dev bun tests/behavioral/sdk/new/live-sdk-smoke.mjs
```

For probe quality rules, read
[`tests/behavioral/PROBE-QUALITY.md`](tests/behavioral/PROBE-QUALITY.md).

## Issues

Useful issues include:

- Exact command or SDK call used.
- Expected behavior.
- Actual output or error.
- Whether it happened locally, on a self-hosted Worker, or on the public demo.
- Session URL only if it does not contain private data.

Do not include secrets, tokens, private source code, or production data in
issues.
