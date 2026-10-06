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
- `startProcess(command, options?)` — backgrounds the command and returns `{ pid, process, ports, startedAt }` immediately
- `files.read/readBytes/write/list/mkdir/delete/exists/stat/lstat/rename/chmod/readRange`
- `runtimes.install/ensure/list`
- `processes.list/kill/logs/write/endInput/resize/signal`
- `ports.expose/unexpose/list`
- `capabilities()`
- `tools(options?)`

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
| a node or bun program's fetch, `http`/`https` and clients over them (node-fetch, undici), WebSocket | yes |
| one-shot Python, Ruby, Bash, Clang and WASI programs, and the Node, Bun, Python and Ruby REPLs | yes: every facet a session or a `loaderFacetHost` opens goes out through it |
| a plain TCP socket a program opens | yes, to the egress's `connect()` |
| TLS a runtime makes itself over a plain socket (CPython's `ssl`: pip's downloads, `urllib` over https) | yes: the egress's `connect()` carries the encrypted stream |
| a node program's TLS socket (`tls.connect`) | refused by name (`ERR_NIMBUS_EGRESS_TLS`): a Fetcher's `connect()` carries plain TCP only, so the TLS session could only be made off the egress |
| a worker or dev server a command starts (wrangler dev, vite) | yes |
| an inline `node` program (a host without Dynamic Workers: Bun, Node): fetch, `http`/`https` | yes, as Node's fetch: the response streams, an unread body is not read, the program's redirect mode is honored and each hop is its own request through the egress |
| an inline `node` program's WebSocket | refused by name: a WebSocket cannot cross the inline program's realm to the host |
| a facet of `localFacetHost` (Bun, Node): its fetch | yes, as an inline `node` program's |
| a facet of `localFacetHost`: its WebSocket | refused by name, as an inline `node` program's |
| Nimbus's own traffic (R2, runtime catalog, OAuth, AI, static assets, its Durable Objects) | no |

HTTPS made by fetch or `https` is unaffected by the TLS limit: it is a
request, not a socket. A session's processes keep their network across an
instance reset: a launch the reset interrupted is re-driven through the same
egress, before or without a reconnect.

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
