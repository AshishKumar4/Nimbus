# gofumpt compatibility fixture

This builds gofumpt v0.12.0 with Go 1.27.4 as a candidate for the existing
`wasi-cli-runner@1`. It does not add a catalog entry, ship a Wasm artifact,
or make the Go compiler available inside Nimbus.

Run from the repository root with Go 1.27.4, Node, Bun, and the existing
Nimbus probe build and dependencies:

```sh
out=$(mktemp -d)
node packages/worker/wasm/gofumpt/build-compat.mjs "$out"
bun tests/unit/manual/gofumpt-compat.mjs "$out"
rm -r "$out"
```

The build checks the gofumpt module and go.mod digests, builds a pristine
native oracle, and applies a Wasm-only overlay without editing the installed
toolchain or module cache. It checks the candidate's imports with the existing
verifier. The probe loads it into a scratch local workerd, tests native output
and exit-status parity (including relative paths with a stale `PWD`), and
checks a delayed pipe and SIGINT sent to the live formatter PID.

The guest uses Nimbus's cwd, mode and access imports. It consumes the host's
private restart errno on stream I/O and takes signals at that boundary and at
cooperative scanner, AST, and printer checkpoints. Those checkpoints are not
general Go/Wasm preemption or a latency guarantee for arbitrary Go code.

Closed stdout is a known parity gap: upstream Go/WASI does not take the
native Go runtime's SIGPIPE action on EPIPE. Formatting can report a write
error and exit 2, and list mode can ignore the failed write. The fixture
does not claim native parity for a downstream reader that closes early.

Release work is separate: pin the compiler distribution and artifacts, ship
the licenses, prove the build lane reproduces the bytes, and verify the
install and rehydration from an isolated release catalog.
