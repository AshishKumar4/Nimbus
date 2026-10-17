// workloads.mjs — the readiness commands the TTI benchmark times and the
// live smoke checks: each command, what a pass proves, and the output that
// proves it. A pass also needs exit status 0. Timing, sandbox ownership and
// reporting stay with each runner.
//
// `node -v` does not boot Node on Nimbus: it is answered by an argv fast path
// in runtime-registry.ts. Upstream's benchmark uses it as proof that "the
// Node.js runtime is available and functional", which on Nimbus it is not, so
// the others are commands that genuinely execute.

export const WORKLOADS = {
  // Upstream's readiness command, verbatim.
  'node-version': {
    command: 'node -v',
    proves: 'sandbox reachable and dispatching commands (NOT that Node booted)',
    verify: (r) => /^v\d+\.\d+\.\d+/.test(r.stdout),
  },
  // A real process whose output the caller cannot predict, so a pass proves
  // the sandbox actually ran something.
  shell: {
    command: 'echo $((6*7))-$$',
    proves: 'a real process ran in the sandbox and returned computed output',
    verify: (r) => /^42-\d+/.test(r.stdout.trim()),
  },
  'node-exec': {
    command: 'node -e "console.log(6*7)"',
    proves: 'the Node.js runtime booted and executed JavaScript',
    verify: (r) => r.stdout.trim() === '42',
  },
};
