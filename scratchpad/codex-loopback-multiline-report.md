# Loopback HTTP and multiline terminal fixes

## Commit 1: `fix(net): route in-session loopback HTTP through the session port registry`

Commit: `e57cbf5`

- Added a typed loopback-router seam to the Lifo kernel and wired it during
  session initialization to the session `PortRegistry` used by previews and
  programmatic port listing.
- Curl now recognizes `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]` as
  loopback. It checks legacy in-shell HTTP handlers first, then the session
  router.
- A loopback miss is terminal and returns curl exit 7 with a connection error;
  it cannot fall through to Cloudflare edge `fetch` and produce error 1003.
- The Lifo node-compatible HTTP client uses the same lookup order and treats a
  loopback miss as `ECONNREFUSED` instead of issuing an external fetch.
- `tests/behavioral/runtime-invocation.mjs` now gates the in-shell curl request
  to the facet-backed Node server instead of labeling the failure a platform
  limitation.
- Added `tests/unit/lifo-loopback-routing.mjs` for session-router hits, all four
  loopback host forms, terminal misses, legacy handlers, node-compatible HTTP,
  and unchanged non-loopback fetch behavior.

### Red to green

- Red: `bun tests/unit/lifo-loopback-routing.mjs` returned `external-body` for
  `localhost:5000` instead of `facet-loopback-body`, proving the request escaped
  through the external-fetch seam.
- Green: the same test passes, with no external fetch on loopback hits or
  misses and an exit-7 miss containing no `error code: 1003`.

## Commit 2: `fix(term): convert LF at the xterm boundary for mirrored + tab process output`

- Hoisted the existing shell and REPL newline conversion into the shared
  `normalizeTerminalNewlines` helper.
- Applied the helper only at server-side xterm writes for mirrored non-TTY
  stdout/stderr and exit-dump replay. Process-log storage and WebSocket payloads
  remain raw and byte-identical.
- Added `attachedTty` to process spawn events. Facet, shell, npm-bin, staged
  artifact, and built-in Vite spawn paths now report the real classification.
- Process tabs derive raw-terminal behavior from `attachedTty`. `longRunning`
  remains responsible only for auto-opening/focusing the process stream.
- Hydration uses `/api/processes[].attachedTty`, which was already the
  authoritative server value.
- Added `tests/unit/process-terminal-line-endings.mjs` for non-TTY stdout and
  stderr conversion, attached-TTY mirror suppression, exit-dump conversion,
  and raw log-store preservation.
- Extended `tests/behavioral/preview/process-logs-stream.mjs` to gate an
  explicit `attachedTty: false` spawn event and raw LF preservation in backlog
  and live chunk frames.

### Red to green

- Red: `bun tests/unit/process-terminal-line-endings.mjs` observed
  `a\nb\n` and color-wrapped `c\nd\n` at the terminal stub instead of CRLF.
- Green: the terminal receives `a\r\nb\r\n`, stderr is converted inside its
  ANSI color wrapper, attached-TTY output is not mirrored, exit-dump chunks are
  converted, and stored chunks remain the original LF strings.

## Verification

- `./node_modules/.bin/tsc --noEmit` — pass.
- `bun run --cwd packages/worker typecheck` — pass for worker and frontend.
- `bun run --cwd packages/worker build` — pass.
- Every `tests/unit/*.mjs` script — pass. The two OpenTUI source-dependent
  scripts reported their existing skip because the optional OpenTUI source
  checkout was absent.
- `bun tests/unit/lifo-loopback-routing.mjs` — pass after the final combined
  build.
- `bun tests/unit/process-terminal-line-endings.mjs` — pass after the final
  combined build.
- Live behavioral probes were not run: this implementation task explicitly
  prohibited network use and assigned production live gates to Claude.

## Residual scope and risk

- The Python client-socket bridge is intentionally deferred. The current
  Python socket shim is server-only, and it is not installed for `python -c`
  or REPL execution, so Python `urllib`/client-socket loopback and outbound
  networking require a separate runtime-boundary design and tests.
- Genuine attached-TTY streams remain raw by design; global xterm `convertEol`
  was not enabled, so full-screen TUI control sequences are not rewritten.
- Production confidence still requires the assigned live gates for facet-backed
  Flask/Node loopback curl and browser process-tab rendering.
