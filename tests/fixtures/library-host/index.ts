import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod/v4';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { composeFabric } from '@nimbus-sh/fabric/composition.js';
import { adoptGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import {
  composeHostedRuntime,
  runtimeCatalogSource,
  type HostedRuntime,
  type HostedRuntimeOptions,
} from '@nimbus-sh/worker/workspace-host';
import { loaderFacetHost } from '@nimbus-sh/worker/facet-host';

export {
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
} from '@nimbus-sh/worker/workspace-host';

composeFabric({
  supervisorEntrypoint: 'SupervisorRPC',
  hostNamespace: 'WORKSPACES',
  hostDispatchMethod: 'supervisorOp',
});

type Env = HostedRuntimeOptions['env'] & {
  WORKSPACES: DurableObjectNamespace<EmbeddedWorkspace>;
  TEST_TOKEN: string;
};
type RuntimeTask = Parameters<HostedRuntimeOptions['lifecycle']['schedule']>[0];
type ScheduledTask = { reason: RuntimeTask | 'host'; at: number };
const TASKS_KEY = 'fixture:scheduled';
const ExecRequest = z.object({
  command: z.string(),
  options: z.object({
    cwd: z.string().optional(),
    shellId: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().positive().optional(),
  }).optional(),
});
let isolateId = '';

export class EmbeddedWorkspace extends DurableObject<Env> {
  private runtime: Promise<HostedRuntime> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    isolateId ||= crypto.randomUUID();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS host_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    ctx.storage.sql.exec("INSERT OR IGNORE INTO host_records VALUES ('keep', 'host-owned')");
  }

  private open(): Promise<HostedRuntime> {
    this.runtime ??= this.compose().catch((error: Error) => {
      this.runtime = null;
      throw error;
    });
    return this.runtime;
  }

  private async compose(): Promise<HostedRuntime> {
    await adoptGeneration(this.ctx);
    const vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
    const pidBase = generation(this.ctx) * PID_GEN_STRIDE;
    vfs.revokeAppendWritersThrough(pidBase);
    const processes = new SessionProcessSupervisor();
    processes.setPidBase(pidBase);
    const workspace = await NimbusWorkspace.create({
      sql: this.ctx.storage.sql,
      transactions: this.ctx,
      vfs,
      processes,
      generation: generation(this.ctx),
      facets: loaderFacetHost(this.env, this.ctx),
      runtimeSource: runtimeCatalogSource(this.env),
      runtimeInstall: 'on-demand',
    });
    return composeHostedRuntime({
      workspace,
      ctx: this.ctx,
      env: this.env,
      ports: new PortRegistry(),
      lifecycle: {
        waitUntil: (task) => this.ctx.waitUntil(task),
        schedule: (reason, at) => this.schedule(reason, at),
        cancel: (reason) => this.cancel(reason),
      },
    });
  }

  private async schedule(reason: ScheduledTask['reason'], at: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const tasks = await txn.get<ScheduledTask[]>(TASKS_KEY) ?? [];
      const next = [...tasks.filter((task) => task.reason !== reason), { reason, at }];
      await txn.put(TASKS_KEY, next);
      await txn.setAlarm(Math.min(...next.map((task) => task.at)));
    });
  }

  private async cancel(reason: RuntimeTask): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const tasks = await txn.get<ScheduledTask[]>(TASKS_KEY) ?? [];
      const next = tasks.filter((task) => task.reason !== reason);
      await txn.put(TASKS_KEY, next);
      if (next.length > 0) await txn.setAlarm(Math.min(...next.map((task) => task.at)));
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const tasks = await this.ctx.storage.get<ScheduledTask[]>(TASKS_KEY) ?? [];
    for (const task of tasks.filter((entry) => entry.at <= now)) {
      if (task.reason === 'host') {
        await this.ctx.storage.put(TASKS_KEY, tasks.filter((entry) => entry.reason !== 'host'));
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO host_records VALUES ('alarm-fired', 'yes')");
      } else {
        await this.cancel(task.reason);
        await (await this.open()).onScheduled(task.reason);
      }
    }
  }

  supervisorOp(envelope: Parameters<HostedRuntime['supervisorOp']>[0]) {
    return this.open().then((runtime) => runtime.supervisorOp(envelope));
  }

  private async hostState() {
    return {
      hostRows: [...this.ctx.storage.sql.exec<{ id: string; value: string }>('SELECT id, value FROM host_records ORDER BY id')],
      scheduled: await this.ctx.storage.get<ScheduledTask[]>(TASKS_KEY) ?? [],
      alarm: await this.ctx.storage.getAlarm(),
      isolateId,
      generation: generation(this.ctx),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/destroy' && request.method === 'DELETE') {
      if (this.runtime) await (await this.runtime).close();
      for (const ws of this.ctx.getWebSockets('fixture-shell')) ws.close(1000, 'test finished');
      // This fixture owns the whole test object; runtime.close must not erase it.
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.runtime = null;
      return Response.json({ deleted: true });
    }
    if (path === '/host-alarm' && request.method === 'POST') {
      await this.schedule('host', Date.now() + 3_600_000);
      return Response.json(await this.hostState());
    }
    if (path === '/close' && request.method === 'POST') {
      if (this.runtime) await (await this.runtime).close();
      return Response.json(await this.hostState());
    }
    if (path === '/evict' && request.method === 'POST') {
      await this.ctx.storage.sync();
      this.ctx.abort('library-host acceptance: reopen storage');
    }
    const runtime = await this.open();
    if (path === '/state') {
      return Response.json({
        ...await this.hostState(),
        files: runtime.workspace.stats(),
        installed: runtime.workspace.runtimes.list(),
        processes: await runtime.listProcesses(),
        ports: await runtime.listPorts(),
        terminalAttachmentsPreserved: this.ctx.getWebSockets('fixture-shell').every((ws) =>
          z.object({ hostProperty: z.literal('preserve-me') }).safeParse(ws.deserializeAttachment()).success),
      });
    }
    if (path === '/exec' && request.method === 'POST') {
      const input = ExecRequest.parse(await request.json());
      return Response.json(await runtime.exec(input.command, input.options));
    }
    if (path === '/start' && request.method === 'POST') {
      const input = ExecRequest.parse(await request.json());
      return Response.json(await runtime.startProcess(input.command, input.options));
    }
    if (path === '/file' && request.method === 'PUT') {
      const input = z.object({ path: z.string(), content: z.string() }).parse(await request.json());
      await runtime.workspace.fs.writeFile(input.path, input.content);
      return Response.json({ written: true });
    }
    if (path === '/file' && request.method === 'GET') {
      const file = new URL(request.url).searchParams.get('path');
      if (!file) return new Response('Missing path', { status: 400 });
      return Response.json({ content: await runtime.workspace.fs.readFile(file) });
    }
    if (path === '/exists') {
      const file = new URL(request.url).searchParams.get('path');
      if (!file) return new Response('Missing path', { status: 400 });
      return Response.json({ exists: await runtime.workspace.fs.exists(file) });
    }
    if (path === '/terminal-size') {
      return Response.json({ columns: runtime.terminal.cols, rows: runtime.terminal.rows });
    }
    if (path === '/logs') {
      const pid = z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get('pid'));
      return Response.json(await runtime.processLogs(pid));
    }
    if (path === '/install' && request.method === 'POST') {
      const { spec } = z.object({ spec: z.string() }).parse(await request.json());
      return Response.json(await runtime.workspace.runtimes.install(spec));
    }
    if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['fixture-shell']);
      server.serializeAttachment({ hostProperty: 'preserve-me' });
      await runtime.attachTerminal(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await (await this.open()).terminalFrame(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.runtime) await (await this.runtime).terminalClose(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.runtime) await (await this.runtime).terminalClose(ws);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TEST_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.TEST_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const match = /^\/(?:workspaces|s)\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const [, name, path] = match;
    if (name === undefined || path === undefined) return new Response('Invalid workspace', { status: 400 });
    url.pathname = path;
    return env.WORKSPACES.get(env.WORKSPACES.idFromName(name)).fetch(new Request(url, request));
  },
};
