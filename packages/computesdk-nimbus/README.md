# @computesdk/nimbus

[Nimbus](https://nimbus-os.dev) provider for [ComputeSDK](https://www.computesdk.com).

Nimbus is a POSIX-like OS that runs on Cloudflare Workers and Durable Objects.
A sandbox is a Durable Object with a durable filesystem. There is no VM and no
container, so a sandbox starts in roughly the time Cloudflare takes to create
the Durable Object.

## Installation

```bash
npm install @computesdk/nimbus
```

## Setup

The provider talks to a Nimbus deployment over its remote SDK API, which the
deployment must have enabled:

```ts
createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } });
```

Then point the provider at it:

```bash
NIMBUS_ENDPOINT=https://your-deployment.example.com
NIMBUS_TOKEN=your_nimbus_jwt
# Optional: the deployment's NIMBUS_PREVIEW_HOST_SUFFIX, which enables
# host-form port preview URLs.
NIMBUS_PREVIEW_HOST_SUFFIX=example.com
```

Tokens are minted with `issueNimbusToken` from `@nimbus-sh/sdk/token` using the
deployment's `JWT_SECRET`.

## Usage

```ts
import { nimbus } from '@computesdk/nimbus';

const compute = nimbus({
  endpoint: process.env.NIMBUS_ENDPOINT,
  token: process.env.NIMBUS_TOKEN,
});

const sandbox = await compute.sandbox.create();

const result = await sandbox.runCommand('node -v');
console.log(result.stdout);

await sandbox.filesystem.writeFile('server.js', 'require("http").createServer().listen(3000)');
const url = await sandbox.getUrl({ port: 3000 });

await sandbox.destroy();
```

## Configuration

```ts
interface NimbusConfig {
  /** Base URL of the Nimbus deployment. Falls back to NIMBUS_ENDPOINT. */
  endpoint?: string;
  /** Nimbus JWT. Falls back to NIMBUS_TOKEN. */
  token?: string;
  /** Deployment's NIMBUS_PREVIEW_HOST_SUFFIX, for host-form preview URLs. */
  previewHostSuffix?: string;
  /** Tenant segment of the sandbox address. Defaults to `default`. */
  tenant?: string;
  /** Subject segment of the sandbox address. Defaults to `_`. */
  subject?: string;
  /** Sandbox filesystem root. Defaults to `/home/user`. */
  root?: string;
  /** Default command timeout in milliseconds. */
  timeout?: number;
}
```

`tenant` and `subject` form the sandbox's address alongside its id
(`${tenant}:${subject}:${id}`), so two sandboxes with the same id under
different tenants are different sandboxes.

## Supported operations

| Operation | Support |
|---|---|
| `create`, `destroy` | Yes |
| `getById` | Yes, via an ownership marker — see below |
| `runCommand` | Yes, including `cwd`, `env`, `timeout`, `background` |
| `runCommand` streaming | Framework-owned — see below |
| `getInfo` | Yes |
| `getUrl` | Yes |
| `filesystem.*` | Yes |
| `list` | **Throws.** Nimbus has no sandbox enumeration |
| Templates, snapshots | **Throws.** Nimbus has no template or snapshot concept |

## Behaviour worth knowing

**`list` throws rather than returning `[]`.** A Nimbus sandbox is a Durable
Object addressed by name, and Cloudflare exposes no way to enumerate the
objects in a namespace. Returning an empty array would claim there are no
sandboxes, which is false. Keep your own registry of the ids you created.

**`getById` uses an ownership marker.** Durable Objects are created on first
access, so asking Nimbus for a sandbox never fails and proves nothing about
whether it existed. `create` therefore writes `.computesdk/sandbox.json` inside
the sandbox root, recording the creation time. `getById` reads that file and
reports a miss when it is absent. The probe itself materializes an empty
Durable Object, so a miss destroys it before returning `null`.

This also means `getInfo().createdAt` is the sandbox's real creation time,
read from the marker, rather than the moment `getInfo` was called.

**Paths resolve against the sandbox root.** Nimbus filesystem calls take
VFS-absolute paths and do no root resolution of their own, so the provider
resolves relative paths against `root` (default `/home/user`). Absolute paths
are passed through untouched.

**`readdir` does not populate `size` or `modified`.** Nimbus returns name and
type from a directory listing. Size and modification time would each cost an
extra round trip per entry. Both stay unset, so one listing does not become
N+1 network calls.

**`runCommand` with `background: true` returns exit code 0.** The zero means
the process started, and says nothing about whether it succeeded. The process
is still running when the call returns.

**ComputeSDK implements the streaming callbacks, not this provider.**
When `onStdout`/`onStderr` are passed, `@computesdk/provider` seeds a
`daemond` daemon into the sandbox and reads its SSE feed. It strips the
callbacks before delegating to the provider. The seed launcher is a
`node -e` program, so streaming works only when Nimbus's programmatic `exec`
returns Node's stdout. It currently does not (see below).

**Known gap: Node stdout is lost on the programmatic exec path.** Any
command that runs the Node runtime (`node -e`, `node script.js`, and
therefore `runCode`) exits 0 with empty stdout when driven through the SDK's
remote RPC. `node -v` appears to work only because Nimbus answers `-v` from an
argv fast path without booting Node. The same defect is what makes
streaming callbacks fail, since the daemon seed is a `node -e` program.
Shell and coreutils commands are unaffected.

**Environment from `create({ envs })` is re-applied per command.** Nimbus has no
persistent per-sandbox environment, so the provider stores the environment in
the marker and merges it into every `runCommand`.

## Benchmarks

I measured with ComputeSDK's own TTI definition: `compute.sandbox.create()`
through the first successful `runCommand`, with `destroy` untimed. Scoring
uses their `computeStats` (5% trimmed both ends) and `computeCompositeScores`
(10s ceiling, weights 0.60/0.25/0.15, multiplied by success rate). Reproduce
with `bench/tti.mjs` and `bench/score.mjs`.

n=100 per shape, a fresh sandbox id per trial so every trial creates a cold
Durable Object. Nothing is pre-warmed.

| shape | median | p95 | p99 | score | success |
|---|---|---|---|---|---|
| sequential (`node -v`) | 780 ms | 1020 | 1063 | 91.17 | 100% |
| sequential (`shell`) | 770 ms | 992 | 1128 | 91.21 | 100% |
| staggered x100 | 751 ms | 1040 | 1123 | 91.21 | 100% |
| burst x100 | 1278 ms | 1637 | 1743 | 85.63 | 100% |

Phase breakdown: create ~700 ms, first command ~62 ms, plain HTTP round trip
to the same origin ~20 ms, bare `ready()` without the provider 650-757 ms.

Against ComputeSDK's published leaderboard this is mid-pack, roughly 21st of
26 sequential and 17th under burst. It beats Cloudflare's own container
Sandbox SDK on every shape: 780 vs 2000 ms sequential, 1278 vs 4417 burst,
751 vs 3764 staggered. E2B is faster sequentially at 576 ms.

Two caveats. I took these numbers from a different network vantage point than
the published leaderboard, so this is not a strict head-to-head. A strict
comparison needs both on one runner. The providers at the top of that
leaderboard report 13-17 ms, which is below the time any VM or container takes
to boot. Whatever those numbers measure, it is not a cold start. Every trial
here is one.

### `node -v` does not prove Node runs

ComputeSDK's benchmark uses `node -v` as its readiness command and documents it
as confirming "the Node.js runtime is available and functional". On Nimbus it
does not: `runtime-registry.ts` answers `-v` from an argv fast path that writes
a version constant and returns, without booting Node. That is a hollow signal
in the benchmark itself, not only here. The `shell` workload above exists for
that reason. The caller cannot predict its output, so a pass proves a real
process ran. It lands at the same speed, so the headline is unaffected.

## License

MIT
