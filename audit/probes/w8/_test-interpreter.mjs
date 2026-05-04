// Shared test interpreter — a tiny set of "commands" used by both the
// MockFacetManager (when running in facet-direct mode) and the
// MockCommandRegistry (when running in pure-builtin mode).
//
// Real impls of these commands live in src/unix-commands.ts; the test
// interpreter is intentionally separate so unit tests don't pull in the
// full DO machinery.

export const TEST_INTERPRETER = {
  fns: {
    echo: ({ args, hooks }) => { hooks.onStdout((args || []).join(' ') + '\n'); return 0; },
    'echo-no-newline': ({ args, hooks }) => { hooks.onStdout((args || []).join(' ')); return 0; },
    cat: ({ stdin, hooks }) => { hooks.onStdout(stdin || ''); return 0; },
    true: () => 0,
    false: () => 1,
    'exit-code': ({ args }) => parseInt((args || [])[0]) || 0,
    'env-print': ({ env, hooks }) => {
      hooks.onStdout(JSON.stringify(env || {}) + '\n');
      return 0;
    },
    'split-streams': ({ hooks }) => {
      hooks.onStdout('out-line\n');
      hooks.onStderr('err-line\n');
      return 0;
    },
    'sleep-ms': async ({ args }) => {
      const ms = parseInt((args || [])[0]) || 0;
      await new Promise(r => setTimeout(r, ms));
      return 0;
    },
    'slow-output': async ({ args, hooks }) => {
      const n = parseInt((args || [])[0]) || 3;
      const ms = parseInt((args || [])[1]) || 50;
      for (let i = 0; i < n; i++) {
        await new Promise(r => setTimeout(r, ms));
        hooks.onStdout(`chunk${i}\n`);
      }
      return 0;
    },
    'crash-after': async ({ args, hooks }) => {
      const n = parseInt((args || [])[0]) || 1;
      for (let i = 0; i < n; i++) {
        hooks.onStdout(`pre-crash-${i}\n`);
      }
      throw new Error('synthetic crash');
    },
  },
};
