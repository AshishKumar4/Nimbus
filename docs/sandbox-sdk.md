# Nimbus Sandbox SDK

Nimbus exposes a programmable sandbox API for Cloudflare Workers and Durable
Objects. Use it for backend services that need isolated execution, persistent
files, runtime installation, process management, and preview ports.

## Packages

- `@nimbus-sh/sdk/sandbox` provides the sandbox client.
- `@nimbus-sh/sdk/worker` re-exports the Worker embedder API.
- `@nimbus-sh/sdk/flue` maps a Nimbus sandbox to Flue's sandbox provider
  contract.
- `@nimbus-sh/worker` contains the runtime implementation.
- `@nimbus-sh/config` provides typed Nimbus and Wrangler config helpers.
- `@nimbus-sh/cli` provides setup, token, session, scaffold, and runtime-sync
  commands.

## Backend Worker Usage

```ts
import { Nimbus } from '@nimbus-sh/sdk/sandbox';
import { defineNimbusConfig } from '@nimbus-sh/config';

const nimbusConfig = defineNimbusConfig({
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: {
        preinstall: ['python'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
      tools: { namespace: 'sandbox', kind: 'sandbox' },
    },
  },
});

export default {
  async fetch(_request, env) {
    const nimbus = Nimbus.fromEnv(env, nimbusConfig);
    const box = nimbus.sandbox('job-123');

    await box.ready();
    const result = await box.exec('python -c "print(2 + 2)"');

    return Response.json(result);
  },
};
```

## Remote Usage

Use `Nimbus.connect(...)` when a Worker or server calls a deployed Nimbus
embedder over HTTP:

```ts
import { Nimbus } from '@nimbus-sh/sdk/sandbox';

const nimbus = Nimbus.connect({
  endpoint: 'https://nimbus.example.com',
  token: env.NIMBUS_TOKEN,
});

const box = nimbus.sandbox('job-123');
const result = await box.exec('node -e "console.log(2 + 2)"');
```

The deployed Worker must enable the SDK API:

```ts
import { createNimbusHandler } from '@nimbus-sh/sdk/worker';
import { defineNimbusConfig } from '@nimbus-sh/config';

const config = defineNimbusConfig({
  sandboxes: {
    default: {
      root: '/home/user',
      runtimes: { preinstall: ['python'], onDemand: true },
    },
  },
});

export default createNimbusHandler({
  sdk: { remote: true, config },
});
```

## Sandbox Handle

`nimbus.sandbox(id, options?)` returns a sandbox handle with:

- `ready()`
- `exec(command, options?)`
- `runCode(code, options)`
- `runner(options?)` — a warm node process for many short programs; see [Runners](#runners)
- `startProcess(command, options?)` — backgrounds the command and returns `{ pid, process, ports, startedAt }` immediately
- `files.read/readBytes/write/list/mkdir/delete/exists/stat/lstat/rename/chmod/readRange`
- `runtimes.install/ensure/list`
- `processes.list/kill/logs/write/endInput/resize/signal`
- `ports.expose/unexpose/list`
- `capabilities()`
- `tools(options?)`

## Runners

`exec` and `runCode` start a new process for each command, which costs a
node program its launch. A runner is for many short programs in a row, such
as an agent's `eval` tool. It is one warm node process that runs each call's
code as a line typed at the node REPL:

```ts
const runner = sandbox.runner({ cwd: '/home/user/app' });
const first = await runner.run('const rows = require("./rows.json"); rows.length');
// { value: '3', stdout: '', stderr: '', fresh: true, ms: … }
const next = await runner.run('rows.map((r) => r.id)', { timeoutMs: 10_000 });
// { value: '[ 1, 2, 3 ]', …, fresh: false }
await runner.close();
```

- **One call is one REPL line.** Top-level `await` works. What a call
  declares (`const`, `let`, `function`, `class`) or sets on `globalThis`
  stays for the next call. `require` reads the session's files from the
  runner's `cwd`, and `import()` resolves from there too.
- **No isolation between calls.** Calls of one runner share one process and
  its memory. Use a runner for one caller's work, and another runner (or
  `exec`) for work that must not see it.
- **The answer.** `value` is the last expression's value as `util.inspect`
  shows it (`'undefined'` for a statement), absent when the call threw.
  `stdout` and `stderr` hold what this call wrote. `error` holds what it
  threw: an Error's `name`, `message`, `stack` and `code`, or another value
  as `util.inspect` shows it, in `message`. `ms` is the call's time in the
  session. The session's clock does not move while code computes, so time
  a call that computes from your side.
- **Files.** A call reads the session's files as they are when it starts,
  and its writes reach the session before it answers. The runner's `cwd`
  and `/tmp` are kept current. A synchronous read elsewhere of a file that
  changed after the runner started can answer `EAGAIN` once; `fs.promises`
  reads it.
- **What a call leaves pending.** The call answers once its code's value
  settles and the requests and file operations it started have ended. A
  timer still pending then does not run. Await what you need.
- **Limits.** `cpuMs` is the CPU time one call may use: 5,000 ms by
  default, at most 300,000. `timeoutMs` is the wall time it may take: none
  by default. Both count from when the runner gets the call, so a first
  call's start in the runner counts too. A call runs on its session's
  thread, so a call that does not yield holds the session until it ends or
  reaches `cpuMs`. The platform ends such a call about 3 s past its
  `cpuMs`: measured 3.7 s after it began with `cpuMs: 1000`, and 8.1 s with
  the default. A call that waits for something that never comes holds one
  of the session's Dynamic Workers until `timeoutMs`, or until `close()`.
- **What a call keeps.** Sockets, streams and requests do not outlive the
  call that opened them, even when a global holds them.
- **Losing a runner.** A call past `cpuMs` (`ERR_NIMBUS_RUNNER_CPU_LIMIT`),
  past `timeoutMs` (`ERR_NIMBUS_RUNNER_TIMEOUT`), past the memory limit
  (`ERR_NIMBUS_RUNNER_MEMORY_LIMIT`), killed (`ERR_NIMBUS_RUNNER_KILLED`),
  closed (`ERR_NIMBUS_RUNNER_CLOSED`), or calling `process.exit`
  (`ERR_NIMBUS_RUNNER_EXITED`) ends its runner. So does any other failure of
  its worker (`ERR_NIMBUS_RUNNER_LOST`). The call answers that `error` at
  once, with `name: 'NimbusRunnerError'`. The next call starts a new
  runner. A call whose `timeoutMs` came while it still waited for a
  Dynamic Worker ran nothing, and its runner keeps its state.
- **Output.** `value`, `stdout`, `stderr` and the error's `message` and
  `stack` each carry up to about 2.9 million characters; past that the text
  is cut, and says so.
- **`fresh`.** A `fresh: true` answer ran in a new runner, where nothing an
  earlier call left is there: the first call, the call after one that lost
  the runner, the call after the platform dropped an idle runner, and the
  call after the session restarted.
- **Cost.** A warm call took 9 ms in the session at the median, against
  about 200 ms for a warm `node -e` one-shot; a runner's first call took
  about 700 ms (measured 2026-10-23). An idle runner holds none of the
  session's ten Dynamic Workers in flight; a call holds one while it runs.
  A session can keep more than ten idle runners warm.
- **Options.** `runner({ id, cwd, env, execId })`. Calls with the same `id`
  share one runner; the default `id` is a new UUID. A scoped hosted session
  has runners of its own. Close a runner you no longer need: it keeps a
  process until then. `cwd` resolves against
  the sandbox root, its default, as `exec`'s does. `env` defaults to the
  session's exported environment. A runner takes the options its first call
  sent, and a call that sends other options for the same `id` is refused.
  `close()` ends the runner, and a call it is running.

## Users and Permissions

A session has Unix users and permissions. Commands run as the session's user
(uid 1000) unless they ask for another, and the session's own surfaces act
as that user too: the SDK's `files` methods, the browser editor, the agent's
file tools and the session's HTTP file routes. Each of them is refused what
the user's own shell is refused. An embedder holding the Durable Object
binding can act as another identity by naming it, for example
`sandbox.files.as(CRED_KERNEL).delete(path)` (both exported by
`@nimbus-sh/sdk`).

**The session's user has passwordless root.** `sudo` and `su` run any
command as root, with no password. So these rules guard against accidents
and against the session's own tools reaching past the user. They do not
stand against a program in the session that uses `sudo`.

The same applies to protected files, `_rpcWriteProtectedRootFile`: a
kernel-owned, read-only file in a sticky directory, which the session's user
cannot change or remove through ordinary file operations. A program that
runs `sudo` can. Do not rely on a protected file to keep a value from code
running in the session.

## Runtime Contract

Nimbus is a Cloudflare Worker, Durable Object, and WebAssembly sandbox. It
supports:

- persistent SQLite-backed virtual filesystems
- Node, Bun, npm, git, shell, Python, Ruby, clang, and WASI/WebAssembly execution
- long-running process metadata and logs
- preview-port routing for HTTP development servers
- runtime installation from the Nimbus runtime catalog

Nimbus does not provide Docker, Linux containers, GPUs, `apt`, custom VM
images, native Linux ELF execution, or raw TCP listeners.

## Routing a Sandbox's Network (Egress)

A host can send every network request a workspace's commands and programs
make through a Fetcher of its own, to record, rewrite or refuse it:
`NimbusWorkspace.create({ egress })`, or for the session Durable Object a
`NIMBUS_EGRESS` service binding, or `workspaceEgress()` overridden to mint
one per session:

```ts
export class Egress extends WorkerEntrypoint {
  async fetch(request) { /* allow, rewrite or refuse; then */ return fetch(request); }
  async connect(socket) { /* plain TCP: tunnel or close */ }
}
export class Session extends NimbusSession {
  protected override workspaceEgress() {
    return this.ctx.exports.Egress({ props: { session: this.ctx.id.toString() } });
  }
}
```

The egress is a Fetcher's `fetch` and `connect` (`Pick<Fetcher, 'fetch' |
'connect'>`); on a host without Fetchers, an object with those two methods.
An egress that carries no TCP refuses in its `connect`. A host that composes
a workspace with facets gives them the same network:
`facets: loaderFacetHost(env, ctx, workspaceNetwork(egress))` for Dynamic
Worker facets, `facets: localFacetHost(workspaceNetwork(egress))` on Bun or
Node (`workspaceNetwork` and `ISOLATE_NETWORK` from `@nimbus-sh/core`; one
network per egress object, so it is the workspace's own). Every facet host,
pool and fanout takes a network; Nimbus's own work states `ISOLATE_NETWORK`.

| Traffic | Through the egress |
|---|---|
| git clone, fetch, pull, push, on-demand object fetches | yes |
| npm install (registry and tarballs, every install facet and peer) | yes; the shared packument cache is not used, but an integrity-checked tarball may come from Nimbus's shared tarball cache |
| curl, wget, dig, ping, `npm view`/`search`, gem/bundle | yes |
| pip: PyPI metadata, and the wheel and source downloads (made inside CPython) | yes |
| a node or bun program's fetch, `http`/`https` and clients over them (axios, node-fetch, undici), the `ws` package and the global WebSocket (ws: and wss:, with the program's own upgrade headers) | yes |
| one-shot Python, Ruby, Bash, Clang and WASI programs, and the Node, Bun, Python and Ruby REPLs | yes: every facet a session or a `loaderFacetHost` opens goes out through it |
| a plain TCP socket a program opens | yes, to the egress's `connect()` |
| TLS a runtime makes itself over a plain socket (CPython's `ssl`: pip's downloads, `urllib` over https) | yes: the egress's `connect()` carries the encrypted stream |
| a WebSocket server in the session (`ws`'s `WebSocketServer`, an `http` server's `'upgrade'`) | not available, egress or not: workerd's HTTP server emits `'request'`, never `'upgrade'`; a session's client connecting to one closes with 1006 (`Network connection lost`), measured with `ws` 8.22 and the global WebSocket |
| a node program's TLS socket (`tls.connect`) | through the egress's optional `connectTls({ hostname, port, servername? })`, which makes the TLS session (`servername` when the program names one other than the host); without it, refused by name (`ERR_NIMBUS_EGRESS_TLS`) |
| TLS over a socket the program opened (`tls.connect({ socket })`, STARTTLS) | refused by name (`ERR_NIMBUS_EGRESS_STARTTLS`): the egress carries that connection, and workerd starts no TLS on a connection through a service binding |
| a worker or dev server a command starts (wrangler dev, vite), and a Worker that one loads (`worker_loaders`) | yes |
| an inline `node` program (a host without Dynamic Workers: Bun, Node): fetch, `http`/`https` | yes, as Node's fetch: the response streams, an unread body is not read, the program's redirect mode is honored and each hop is its own request through the egress |
| an inline `node` program's WebSocket | refused by name: a WebSocket cannot cross the inline program's realm to the host |
| a facet of `localFacetHost` (Bun, Node): its fetch | yes, as an inline `node` program's |
| a facet of `localFacetHost`: its WebSocket | refused by name, as an inline `node` program's |
| Nimbus's own traffic (R2, runtime catalog, OAuth, AI, static assets, its Durable Objects) | no |

HTTPS made by fetch or `https` is unaffected by the TLS limit: it is a
request, not a socket. How a TLS socket's name works under an egress:

- `servername: ''` asks Node to send no SNI. It is not forwarded, so the
  egress presents the host name. An egress on workerd cannot send no SNI:
  its TLS always presents the name it checks.
- With a `servername` other than the host, an egress on workerd makes the
  session with `startTls({ expectedServerHostname })`, which checks the
  certificate only after the handshake. A certificate that fails shows up
  after `secureConnect`: as an internal error at the program's first write,
  or as an end with no data at a read, not as a handshake error. No byte the
  program writes reaches the server.
- The name is checked as given. Node removes a trailing dot
  (`example.com.`) before it checks; the egress does not. A session's processes keep their network across an
instance reset: a launch the reset interrupted is re-driven through the same
egress, before or without a reconnect.

To tell which exec made a request, mint an egress per process:
`NimbusWorkspace.create({ egress, egressFor })`, or `egressFor` on the
session. It gets `{ pid, execId }` once per process and returns that
process's egress, or undefined for the workspace's. Everything the process
does goes through it: its programs and their sockets, the commands it runs,
and its Dynamic Worker wherever it is hosted. A host that builds its facets'
network itself makes it with `selectProcessEgress(egress, egressFor,
processes)` over the workspace's process table, not `workspaceNetwork`.

```ts
export class Session extends NimbusSession {
  protected override workspaceEgress() {
    return this.ctx.exports.Egress({ props: { session: this.ctx.id.toString() } });
  }
  protected override egressFor(process: EgressProcess) {
    return this.ctx.exports.Egress({ props: { session: this.ctx.id.toString(), execId: process.execId } });
  }
}
```

## Proteus-Style Tool Provider

`box.tools({ namespace: 'sandbox', kind: 'sandbox' })` returns a provider with
execution, code, file, runtime, process, and port tools. Use it for agent
runtimes that need a sandbox provider without a browser terminal or WebSocket
session.

The provider reports Python and Ruby when policy allows them. It reports clang
as WASI/WebAssembly execution, not Linux ELF execution.

## Flue Connector

Use `@nimbus-sh/sdk/flue` when an agent runtime expects Flue's sandbox
provider contract:

```ts
import { Nimbus } from '@nimbus-sh/sdk/sandbox';
import { nimbusFlue } from '@nimbus-sh/sdk/flue';

const box = Nimbus.fromEnv(env, nimbusConfig).sandbox('job-123');
await box.ready();

const factory = nimbusFlue(box);
const sessionEnv = await factory.createSessionEnv({
  id: 'job-123',
  cwd: '/home/user',
});

await sessionEnv.writeFile('/home/user/main.py', 'print(2 + 2)\n');
const result = await sessionEnv.exec('python /home/user/main.py');
```

The adapter delegates to the same Nimbus SDK methods as `box.tools()`. It does
not add native Linux execution, Docker, or a second filesystem.

## Agentic CLI Compatibility

JavaScript and WASM-based agent tools get persistent home/config files,
npm/npx installs, npm alias dependencies, `child_process.spawn`, `exec`,
`execFile`, piped stdin/stdout/stderr, process streams, process stdin writes,
resize/signal delivery, logs, outbound HTTPS, and preview ports for HTTP-like
agent servers.

Foreground attached npm-bin processes have a TTY-shaped terminal surface with
stdin, raw mode state, resize events, ANSI output, and signal delivery. This is
still alpha and is not a complete POSIX PTY contract. Pi's official
`curl -fsSL https://pi.dev/install.sh | sh` installer and direct npm path are
production-probed. opencode and Proteus-style CLIs are not yet proven to run
unmodified; they need live probes first.

Tools that ship only native platform shards such as `linux-x64`, `darwin`, or
`win32` binaries need a WASM build, pure-JS entrypoint, or Nimbus adapter.
Nimbus does not execute Linux ELF binaries.

## Verification

Useful checks:

```bash
bun tests/behavioral/sdk/new/programmatic-sdk.mjs
bun tests/behavioral/sdk/new/remote-sdk-client.mjs
bun tests/behavioral/sdk/new/remote-sdk-handler.mjs
bun tests/behavioral/sdk/new/flue-adapter.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/sdk/new/live-sdk-smoke.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/sdk/new/live-sdk-remote-smoke.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/agent/new/session-agent-panel.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/editor/monaco/new/welcome-markdown-preview-default.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/preview/new/tabbed-preview-auto-focus-port.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/preview/new/vite-preview-dedupes-port-tab.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/agentic-cli/new/node-child-process-primitives.mjs
BASE=https://nimbus-os.dev bun tests/behavioral/runtime-primitives/npm-alias-dependency.mjs
```
