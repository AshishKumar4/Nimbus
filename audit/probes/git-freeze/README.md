# git-freeze probes

Repro of the P0 bug: `git clone https://github.com/AshishKumar4/Nimbus`
on prod froze at exactly `[git] Updating workdir 1450/1595`.

Trace files:
- `trace-<ISO>.txt` — driven by `/tmp/git-clone-trace.mjs` (P1 ad-hoc),
  records WS frames + 1s tick ledger + final tail.

Repro confirmed against `https://nimbus.ashishkmr472.workers.dev`
on 2026-05-09. Last logged frame: `Updating workdir 1450/1595`.
180s+ of silence after that — no `done.`, no error, no progress.
