/**
 * @computesdk/nimbus — ComputeSDK provider backed by Nimbus.
 *
 * Nimbus is a POSIX-like OS on Cloudflare Workers + Durable Objects. A
 * sandbox is a Durable Object addressed by `${tenant}:${subject}:${id}`,
 * reached through the SDK's remote RPC API (`@nimbus-sh/sdk`).
 *
 * Three Nimbus properties shape this adapter, and each is surfaced rather
 * than papered over:
 *
 *   1. A Durable Object is created on first access, so `Nimbus.sandbox(id)`
 *      is a pure local handle that never fails and carries no proof of
 *      existence. `create` writes an ownership marker and `getById` reads
 *      it, so a miss is a real miss.
 *   2. Nimbus has no session enumeration — no API, no registry — so `list`
 *      throws rather than returning `[]`, which would read as "none exist".
 *   3. Filesystem RPCs take VFS-absolute paths with no root resolution, so
 *      the provider resolves every relative path against the sandbox root
 *      it configured.
 */

import { defineProvider } from '@computesdk/provider';
import type {
  CommandResult,
  CreateSandboxOptions,
  FileEntry,
  RunCommandOptions,
  SandboxInfo,
} from 'computesdk';
import { Nimbus, NimbusRemoteError, type NimbusSandbox } from '@nimbus-sh/sdk';

/**
 * Records provider ownership, the real creation time, and the environment
 * `create` was given. Relative to the sandbox root.
 */
const MARKER_PATH = '.computesdk/sandbox.json';

/** The SDK's own fallback when no profile root is configured. */
const DEFAULT_ROOT = '/home/user';

const DEFAULT_TIMEOUT_MS = 300_000;

export interface NimbusConfig {
  /** Base URL of the Nimbus deployment. Falls back to `NIMBUS_ENDPOINT`. */
  endpoint?: string;
  /** Nimbus JWT, sent as `Authorization: Bearer`. Falls back to `NIMBUS_TOKEN`. */
  token?: string;
  /**
   * The deployment's `NIMBUS_PREVIEW_HOST_SUFFIX`, letting `getUrl` return
   * the `<port>--<sid>.<suffix>` preview origin. Falls back to
   * `NIMBUS_PREVIEW_HOST_SUFFIX`. Without it `getUrl` returns the
   * endpoint-relative `/s/<id>/port/<port>/` form.
   */
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

/**
 * The native handle. `createdAt` and `envs` come from the marker, so
 * `getInfo` reports the sandbox's real creation time rather than the time
 * it happened to be asked, and `getById` restores the creation environment.
 */
export interface NimbusSandboxHandle {
  box: NimbusSandbox;
  id: string;
  root: string;
  createdAt: number;
  envs: Record<string, string>;
}

interface SandboxMarker {
  createdAt: number;
  envs?: Record<string, string>;
}

/**
 * Reads an environment variable without assuming Node. The provider also
 * runs inside a Worker, where there is no `process`.
 */
function readEnv(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

function resolveEndpoint(config: NimbusConfig): string {
  const endpoint = config.endpoint || readEnv('NIMBUS_ENDPOINT');
  if (!endpoint) {
    throw new Error(
      'Missing Nimbus endpoint.\n\n' +
        'Pass it: nimbus({ endpoint: "https://your-deployment.example.com" })\n' +
        'Or set NIMBUS_ENDPOINT in your environment.',
    );
  }
  return endpoint;
}

function resolveRoot(config: NimbusConfig): string {
  return (config.root ?? DEFAULT_ROOT).replace(/\/+$/, '') || '/';
}

/**
 * Nimbus filesystem RPCs do not resolve paths against the sandbox root,
 * so the provider does it — otherwise a relative path silently lands at
 * the VFS root instead of inside the sandbox.
 */
function absolute(root: string, path: string): string {
  return path.startsWith('/') ? path : `${root}/${path}`;
}

function connect(config: NimbusConfig): Nimbus {
  const previewHostSuffix = config.previewHostSuffix || readEnv('NIMBUS_PREVIEW_HOST_SUFFIX');
  return Nimbus.connect({
    endpoint: resolveEndpoint(config),
    token: config.token || readEnv('NIMBUS_TOKEN'),
    config: previewHostSuffix ? { previewHostSuffix } : {},
  });
}

/**
 * Nimbus ids allow `[A-Za-z0-9._-]`, but the host-form preview origin
 * needs lowercase alphanumerics and hyphens, so generated ids stay inside
 * the narrower set to keep `getUrl` on the host form.
 */
function generateSandboxId(): string {
  return `csdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openBox(client: Nimbus, config: NimbusConfig, id: string, root: string): NimbusSandbox {
  return client.sandbox(id, {
    tenant: config.tenant,
    subject: config.subject,
    root,
  });
}

async function readMarker(sandbox: NimbusSandbox, root: string): Promise<SandboxMarker | null> {
  const raw = await sandbox.files.read(absolute(root, MARKER_PATH));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const marker = parsed as SandboxMarker;
      if (typeof marker.createdAt === 'number') return marker;
    }
  } catch {
    // The marker exists but is unreadable: the sandbox is real, only its
    // metadata is lost. Report creation time as unknown, not the sandbox
    // as absent.
  }
  return { createdAt: 0 };
}

export const nimbus = defineProvider<NimbusSandboxHandle, NimbusConfig>({
  name: 'nimbus',
  methods: {
    sandbox: {
      create: async (config: NimbusConfig, options?: CreateSandboxOptions) => {
        if (options?.templateId || options?.snapshotId) {
          throw new Error(
            'Nimbus does not support templates or snapshots. A Nimbus sandbox is a ' +
              'Durable Object with a durable filesystem — provision it by running ' +
              'commands or writing files after create().',
          );
        }

        const root = resolveRoot(config);
        const id = options?.name ?? generateSandboxId();
        const sandbox = openBox(connect(config), config, id, root);

        // `ready()` materializes the Durable Object and applies the
        // deployment's preinstall policy. The marker is what later
        // distinguishes this sandbox from an id that was never created.
        await sandbox.ready();
        const createdAt = Date.now();
        const envs = options?.envs ?? {};
        await sandbox.files.write(
          absolute(root, MARKER_PATH),
          JSON.stringify({ createdAt, envs } satisfies SandboxMarker),
        );

        return { sandbox: { box: sandbox, id, root, createdAt, envs }, sandboxId: id };
      },

      getById: async (config: NimbusConfig, sandboxId: string) => {
        const root = resolveRoot(config);
        const sandbox = openBox(connect(config), config, sandboxId, root);

        // Every Nimbus RPC materializes the Durable Object, so probing an
        // id that was never created makes an empty one. Destroy it again
        // so a miss leaves nothing behind.
        const marker = await readMarker(sandbox, root);
        if (!marker) {
          await sandbox.destroy({ reason: 'computesdk-getbyid-miss' }).catch(() => undefined);
          return null;
        }

        return {
          sandbox: {
            box: sandbox,
            id: sandboxId,
            root,
            createdAt: marker.createdAt,
            envs: marker.envs ?? {},
          },
          sandboxId,
        };
      },

      list: async () => {
        throw new Error(
          'Nimbus does not support listing sandboxes. Sandboxes are Durable Objects ' +
            'addressed by name and Cloudflare exposes no enumeration for them, so keep ' +
            'your own registry of the ids you created.',
        );
      },

      destroy: async (config: NimbusConfig, sandboxId: string) => {
        const root = resolveRoot(config);
        await openBox(connect(config), config, sandboxId, root).destroy({
          reason: 'computesdk-destroy',
        });
      },

      runCommand: async (
        handle: NimbusSandboxHandle,
        command: string,
        options?: RunCommandOptions,
      ): Promise<CommandResult> => {
        // Nimbus has no persistent per-sandbox environment, so the env
        // `create` was given is re-applied on every command.
        const env = { ...handle.envs, ...options?.env };
        const execOptions = {
          cwd: options?.cwd ? absolute(handle.root, options.cwd) : undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
          timeoutMs: options?.timeout,
        };

        if (options?.background) {
          const started = Date.now();
          await handle.box.startProcess(command, execOptions);
          // The process is still running. Exit code 0 reports that the
          // start succeeded — there is no exit status yet to report.
          return { stdout: '', stderr: '', exitCode: 0, durationMs: Date.now() - started };
        }

        // `onStdout`/`onStderr` never arrive here: @computesdk/provider
        // implements streaming itself by seeding a `daemond` daemon into
        // the sandbox and reading its SSE feed, and strips the callbacks
        // before delegating. The seed launcher is a `node -e` program, so
        // streaming works exactly when Nimbus's programmatic exec returns
        // Node's stdout.
        const result = await handle.box.exec(command, execOptions);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.duration,
        };
      },

      getInfo: async (handle: NimbusSandboxHandle): Promise<SandboxInfo> => ({
        id: handle.id,
        provider: 'nimbus',
        status: 'running',
        createdAt: new Date(handle.createdAt),
        timeout: DEFAULT_TIMEOUT_MS,
        metadata: { root: handle.root },
      }),

      getUrl: async (
        handle: NimbusSandboxHandle,
        options: { port: number; protocol?: string },
      ): Promise<string> => {
        const { url } = await handle.box.ports.expose(options.port);
        if (!url) {
          throw new Error(
            `Nimbus could not build a preview URL for port ${options.port}. Pass ` +
              "`previewHostSuffix` (the deployment's NIMBUS_PREVIEW_HOST_SUFFIX) or " +
              '`endpoint` so the provider knows which origin serves previews.',
          );
        }
        return url;
      },

      filesystem: {
        readFile: async (handle: NimbusSandboxHandle, path: string): Promise<string> => {
          const content = await handle.box.files.read(absolute(handle.root, path));
          if (content === null) {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
          }
          return content;
        },

        writeFile: async (handle: NimbusSandboxHandle, path: string, content: string): Promise<void> => {
          await handle.box.files.write(absolute(handle.root, path), content);
        },

        mkdir: async (handle: NimbusSandboxHandle, path: string): Promise<void> => {
          await handle.box.files.mkdir(absolute(handle.root, path));
        },

        // Nimbus readdir returns name and type only. Size and modified time
        // would each cost a stat round trip per entry, so they are left
        // unset rather than turning one listing into N+1 network calls.
        readdir: async (handle: NimbusSandboxHandle, path: string): Promise<FileEntry[]> => {
          const entries = await handle.box.files.list(absolute(handle.root, path));
          return entries.map((entry) => ({
            name: entry.name,
            type: entry.type === 'directory' ? ('directory' as const) : ('file' as const),
          }));
        },

        exists: async (handle: NimbusSandboxHandle, path: string): Promise<boolean> =>
          handle.box.files.exists(absolute(handle.root, path)),

        remove: async (handle: NimbusSandboxHandle, path: string): Promise<void> => {
          await handle.box.files.delete(absolute(handle.root, path), { recursive: true });
        },
      },
    },
  },
});

export { NimbusRemoteError };
export default nimbus;
