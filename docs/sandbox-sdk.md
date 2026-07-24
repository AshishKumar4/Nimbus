# Nimbus Sandbox SDK

Nimbus exposes a programmable sandbox API for Cloudflare Workers and Durable
Objects. The SDK is designed for backend services that need isolated execution,
persistent files, runtime installation, process management, and preview ports.

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
- `startProcess(command, options?)`
- `files.read/write/list/delete/exists/stat`
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

## Proteus-Style Tool Provider

`box.tools({ namespace: 'sandbox', kind: 'sandbox' })` returns a provider with
execution, code, file, runtime, process, and port tools. It is intended for
agent runtimes that need a sandbox provider without depending on a browser
terminal or WebSocket session.

Capabilities are reported honestly. For example, Python is reported when it is
allowed by policy, Ruby is reported when allowed by policy, and clang support
is reported as WASI/WebAssembly execution rather than Linux ELF execution.

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

Nimbus supports many primitives needed by JavaScript and WASM-based agent
tools: persistent home/config files, npm/npx installs, npm alias dependencies,
`child_process.spawn`, `exec`, `execFile`, piped stdin/stdout/stderr, process
streams, process stdin writes, resize/signal delivery, logs, outbound HTTPS, and
preview ports for HTTP-like agent servers.

Foreground attached npm-bin processes have a TTY-shaped terminal surface with
stdin, raw mode state, resize events, ANSI output, and signal delivery. This is
still alpha and is not a complete POSIX PTY contract. Pi's official
`curl -fsSL https://pi.dev/install.sh | sh` installer and direct npm path are
production-probed. Tools such as opencode and Proteus-style CLIs need live
probes before Nimbus docs should claim they run unmodified.

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
