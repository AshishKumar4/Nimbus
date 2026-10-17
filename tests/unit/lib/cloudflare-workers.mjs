// `cloudflare:workers` as unit tests stand it in, outside workerd: each base
// class keeps the ctx and env it is constructed with, as the platform's do.
// Module sets import it by its URL, bundles by its path.

export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}

export const CLOUDFLARE_WORKERS_URL = import.meta.url;
