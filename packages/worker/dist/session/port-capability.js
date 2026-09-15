/**
 * session/port-capability.ts — the durable half of a port's preview capability.
 *
 * `PortRegistry` mints a fresh capability per `register()`, in memory. That is
 * the right lifetime for the in-memory registry and the wrong one for an
 * embedder, which is handed a preview URL and expects it to keep working after
 * the session hibernates and its supervisor is rebuilt from nothing.
 *
 * So the value is persisted at the moment the embedder is told it, and
 * re-adopted into the rebuilt registry when the same logical server comes
 * back. Everything else is the security half of the same rule: a capability
 * names ONE registration, so any other registration on that port retires the
 * durable copy. Only a deliberate restore extends a capability's life, which
 * is why `clearPortCapability` sits next to every `portRegistry.register`,
 * `restorePortCapability` sits only at the two places a dev server is
 * deliberately brought back, and `restoreReservedPortCapability` sits only
 * on the durable spawn's re-adopt path, gated on the stored reservation's
 * owner.
 *
 * The same per-port record also carries a RESERVATION: an owner may hold a
 * port with no capability yet, so a durable application keeps its port across
 * instances whether or not it is currently exposed. Clearing a capability
 * keeps the owner's reservation; only `releasePortReservation` ends it.
 */
import { z } from 'zod/v4';
import { PUBLIC_BEARER_HEADER, renderSessionStatusPage } from '../_shared/session-router.js';
import { PORT_CAPABILITY_KEY_PREFIX } from './keys.js';
/** The shape `createPortCapability` mints: 12 random bytes, hex. */
const PortCapabilitySchema = z.string().regex(/^[a-f0-9]{24}$/);
/** 'scoped' is the default: capability-checked but never the public bearer. */
const PortVisibilitySchema = z.enum(['scoped', 'public']);
/**
 * The optional name alias a reservation may carry: one DNS label, so it can
 * stand where the port stands in a preview host (`<name>--<sid>`). Never
 * purely numeric — a numeric middle label IS a port. No `--`: that is the
 * host-label separator. No 24 lowercase hex: that is ambiguous with a
 * capability label, so parsing could mistake a name for a bearer.
 */
export const APP_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isValidAppName(name) {
    return APP_NAME_RE.test(name) && !name.includes('--')
        && !/^\d+$/.test(name) && !/^[a-f0-9]{24}$/.test(name);
}
const AppNameSchema = z.string().refine(isValidAppName, 'app name must be a DNS label: no --, not numeric, not 24 lowercase hex');
export const PortRecordSchema = z.object({
    kind: z.enum(['explicit', 'derived']).default('explicit'),
    capability: PortCapabilitySchema.nullable(),
    owner: z.string().nullable(),
    visibility: PortVisibilitySchema.optional(),
    name: AppNameSchema.optional(),
});
const RESERVATION_FIRST_PORT = 20000;
const RESERVATION_LAST_PORT = 65535;
export function portRecordKey(port) {
    return `${PORT_CAPABILITY_KEY_PREFIX}${Number(port)}`;
}
function conflict(detail) {
    return new Error(`port reservation conflict: ${detail}`);
}
/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export async function readPortReservation(ctx, port) {
    const stored = PortRecordSchema.safeParse(await ctx.storage.get(portRecordKey(port)));
    if (!stored.success)
        return null;
    return { ...stored.data, visibility: stored.data.visibility ?? 'scoped' };
}
/** Read retained exposure metadata without starting a session or restoring a listener. */
export async function readPortExposure(ctx, port) {
    const stored = await readPortReservation(ctx, port);
    return stored !== null && stored.capability !== null
        ? {
            capability: stored.capability, owner: stored.owner, visibility: stored.visibility,
            ...(stored.name !== undefined ? { name: stored.name } : {}),
        }
        : null;
}
/** Every stored port record, keyed by port — the scan `apps.list` and the name lookups read. */
export async function listPortReservations(ctx) {
    const rows = await ctx.storage.list({ prefix: PORT_CAPABILITY_KEY_PREFIX });
    const out = new Map();
    for (const [key, value] of rows) {
        const port = Number(key.slice(PORT_CAPABILITY_KEY_PREFIX.length));
        const parsed = PortRecordSchema.safeParse(value);
        if (!Number.isInteger(port) || !parsed.success)
            continue;
        out.set(port, { ...parsed.data, visibility: parsed.data.visibility ?? 'scoped' });
    }
    return out;
}
/** The port a name alias resolves to inside this session, or null. */
export async function readPortReservationByName(ctx, name) {
    if (!isValidAppName(name))
        return null;
    for (const [port, reservation] of await listPortReservations(ctx)) {
        if (reservation.name === name)
            return { port, reservation };
    }
    return null;
}
/** The port an owner holds, or null when the owner has no reservation. */
export async function readPortReservationByOwner(ctx, owner) {
    for (const [port, reservation] of await listPortReservations(ctx)) {
        if (reservation.owner === owner)
            return { port, reservation };
    }
    return null;
}
/**
 * Hold a port for `owner` across instances. The owner's existing port is
 * answered again; otherwise the preferred port is claimed, or the lowest
 * free one. A preferred port that another record or a live listener holds
 * is refused, never silently moved.
 *
 * `capability`/`visibility` give the embedder-durable path its URL material
 * up front: a reservation can carry the capability the application will
 * re-adopt when it binds, and the visibility the public bearer form is
 * gated on. An existing reservation for the same owner is answered again,
 * upgraded in place when the caller supplies values it lacks — an existing
 * capability is never rotated, a URL already handed out stays good.
 */
export async function reservePort(ctx, input) {
    if (input.name !== undefined && !isValidAppName(input.name)) {
        throw conflict(`'${input.name}' is not a valid app name (one DNS label, not numeric, not 24 hex)`);
    }
    const claim = async (txn) => {
        const records = await txn.list({ prefix: PORT_CAPABILITY_KEY_PREFIX });
        const taken = new Set(input.occupiedPorts);
        const unowned = new Map();
        let held = null;
        for (const [storedKey, value] of records) {
            const port = Number(storedKey.slice(PORT_CAPABILITY_KEY_PREFIX.length));
            if (!Number.isInteger(port))
                continue;
            const parsed = PortRecordSchema.safeParse(value);
            // listPorts may already have persisted the live capability without an
            // owner. That is an exposure to adopt, not somebody else's reservation.
            if (parsed.success && parsed.data.owner === null)
                unowned.set(port, parsed.data);
            else
                taken.add(port);
            if (!parsed.success)
                continue;
            if (parsed.data.owner === input.owner) {
                held = { port, stored: parsed.data };
            }
            else if (input.name !== undefined && parsed.data.name === input.name
                && !(parsed.data.owner === null && port === input.preferredPort)) {
                throw conflict(`name '${input.name}' is already taken by another app on port ${port}`);
            }
        }
        const preferred = input.preferredPort;
        if (held !== null) {
            if (preferred !== undefined && preferred !== held.port) {
                throw conflict(`owner already holds port ${held.port}, cannot reserve ${preferred}`);
            }
            // Upgrade in place: adopt a caller-supplied capability the row lacks,
            // apply the caller's visibility and/or name — never rotate an existing
            // capability.
            const stored = held.stored;
            const capability = stored?.capability ?? input.capability ?? null;
            const visibility = input.visibility ?? stored?.visibility ?? 'scoped';
            const name = input.name ?? stored?.name;
            if (stored === null || capability !== stored.capability
                || visibility !== (stored.visibility ?? 'scoped') || name !== stored.name) {
                await txn.put(portRecordKey(held.port), {
                    owner: input.owner, kind: stored?.kind ?? input.kind ?? 'explicit', capability, visibility, ...(name !== undefined ? { name } : {}),
                });
            }
            return held.port;
        }
        let port;
        if (preferred !== undefined) {
            if (!Number.isInteger(preferred) || preferred < 1 || preferred > RESERVATION_LAST_PORT) {
                throw conflict(`port ${preferred} is outside 1..${RESERVATION_LAST_PORT}`);
            }
            if (taken.has(preferred))
                throw conflict(`port ${preferred} is held by another owner or listener`);
            port = preferred;
        }
        else {
            port = RESERVATION_FIRST_PORT;
            while (port <= RESERVATION_LAST_PORT && taken.has(port))
                port += 1;
            if (port > RESERVATION_LAST_PORT)
                throw conflict('no free port left to reserve');
        }
        const exposure = unowned.get(port);
        const name = input.name ?? exposure?.name;
        await txn.put(portRecordKey(port), {
            owner: input.owner,
            kind: input.kind ?? 'explicit',
            capability: exposure?.capability ?? input.capability ?? null,
            visibility: input.visibility ?? exposure?.visibility ?? 'scoped',
            ...(name !== undefined ? { name } : {}),
        });
        return port;
    };
    return ctx.storage.transaction(claim);
}
/** End an owner's hold on a port. Another owner's record is left alone and refused. */
export async function releasePortReservation(ctx, input) {
    // The read, the owner check and the delete are one transaction: a concurrent
    // claim or a foreign release cannot interleave between them.
    return ctx.storage.transaction(async (txn) => {
        const stored = await readPortReservation({ storage: txn }, input.port);
        if (stored === null)
            return false;
        if (stored.owner !== input.owner)
            throw conflict(`port ${input.port} is held by another owner`);
        await txn.delete(portRecordKey(input.port));
        return true;
    });
}
export async function readPortCapability(self, port) {
    // The stored record is the only source of truth: a capability belongs to
    // whoever is registered on the port, and its owner field is preserved by
    // persist, never consulted as a gate. Durable ownership rides the
    // reservation's own restore path (restoreReservedPortCapability).
    const stored = await readPortExposure(self.ctx, port);
    return stored?.capability ?? null;
}
/**
 * Re-adopt the persisted capability into whatever the registry holds now.
 * Answers the adopted value, or null when there was nothing to adopt.
 */
export async function restorePortCapability(self, port) {
    const stored = await readPortCapability(self, port);
    if (!stored)
        return null;
    return self.portRegistry.restoreCapability(Number(port), stored) ? stored : null;
}
/**
 * Re-adopt the persisted capability ONLY for the owner the stored record
 * names. The durable re-drive calls this with its own owner: the reservation
 * is the same source of truth the preflight reads, so a release or a foreign
 * claim mid-boot cannot smuggle an exposure across.
 */
export async function restoreReservedPortCapability(self, port, owner) {
    const stored = await readPortReservation(self.ctx, port);
    if (stored === null || stored.owner !== owner || stored.capability === null)
        return null;
    return self.portRegistry.restoreCapability(Number(port), stored.capability) ? stored.capability : null;
}
export async function persistPortCapability(self, port, capability) {
    // Read-modify-write inside the reservation's own transaction, and the stored
    // record is the ONLY source of truth for owner: an SDK ports.list()/expose
    // on a durable application's port must not rewrite the row it is reporting
    // on, or the next durable preflight sees a reservation nobody owns.
    await self.ctx.storage.transaction(async (txn) => {
        const stored = await txn.get(portRecordKey(port));
        const parsed = PortRecordSchema.safeParse(stored);
        await txn.put(portRecordKey(port), {
            capability: PortCapabilitySchema.parse(capability),
            owner: parsed.success ? parsed.data.owner : null,
            kind: parsed.success ? parsed.data.kind : 'explicit',
            ...(parsed.success && parsed.data.visibility !== undefined
                ? { visibility: parsed.data.visibility }
                : {}),
            ...(parsed.success && parsed.data.name !== undefined
                ? { name: parsed.data.name }
                : {}),
        });
    });
}
/**
 * Replace the port's capability with a freshly minted one, in place: owner,
 * visibility and name stay, every URL built on the old value stops
 * resolving. Answers the new capability, or null when no record exists —
 * there is nothing to rotate on a port nobody has reserved or exposed.
 */
export async function rotatePortCapability(self, port, capability) {
    const rotated = await self.ctx.storage.transaction(async (txn) => {
        const parsed = PortRecordSchema.safeParse(await txn.get(portRecordKey(port)));
        if (!parsed.success)
            return null;
        await txn.put(portRecordKey(port), {
            ...parsed.data,
            capability: PortCapabilitySchema.parse(capability),
        });
        return capability;
    });
    // Registry adoption belongs to the caller, after a fresh serving-owner
    // check: the storage await above may have allowed a new listener to bind.
    return rotated;
}
/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export async function clearPortCapability(self, port) {
    await self.ctx.storage.transaction(async (txn) => {
        const stored = PortRecordSchema.safeParse(await txn.get(portRecordKey(port)));
        const record = stored.success ? stored.data : null;
        if (record !== null && record.owner !== null) {
            await txn.put(portRecordKey(port), {
                owner: record.owner,
                kind: record.kind,
                capability: null,
                ...(record.visibility !== undefined ? { visibility: record.visibility } : {}),
                ...(record.name !== undefined ? { name: record.name } : {}),
            });
            return;
        }
        await txn.delete(portRecordKey(port));
    });
}
export function normalizeForwardedHttpPath(path) {
    const text = path || '/';
    return '/' + text.replace(/^\/+/, '');
}
/** True if `innerPath` targets the cirrus-real HMR socket, under any mount base. */
export function isCirrusHmrPath(innerPath) {
    const p = innerPath.split('?')[0];
    return p === '/__nimbus_hmr' || p.endsWith('/__nimbus_hmr');
}
/** The "durable application is (re)starting" 503 page — self-refreshing. */
function renderPortStartingHtml(port) {
    return renderSessionStatusPage({
        title: 'Starting',
        heading: 'Starting&hellip;',
        body: `The application on port <code>${port}</code> is restarting.<br>This page refreshes itself.`,
        metaRefreshSeconds: 3,
    });
}
/**
 * Re-adopt a preview capability the embedder already holds, after a restore
 * re-registered the port under a freshly minted one.
 */
export async function readoptCapability(self, port, capability) {
    if (!capability)
        return;
    if (self.portRegistry.restoreCapability(port, capability)) {
        await persistPortCapability(self, port, capability);
    }
}
/**
 * Route a request to whatever is listening on a session port.
 *
 * The one implementation behind every port-addressed surface: `/port/<n>/`,
 * `/preview/?port=N`, the `<port>--<sid>` preview hostname (which the router
 * forwards as `/port/<n>/`), and the embedder's capability route. They
 * differ only in how the port and the inner path are spelled, so they must
 * not differ in what answers.
 *
 * `mountBase` is the public URL prefix the served app is mounted at for THIS
 * request — '' for a root-mounted `<port>--<sid>` host, '/s/<sid>/preview' for
 * the preview path. The in-process Cirrus dev server rewrites base-relative
 * URLs (module URLs, <base href>, BASE_URL, router basename), so it is handed
 * the base directly: the generic port proxy strips the Nimbus base header at
 * the untrusted-code boundary and cannot carry it, and a plain user server on
 * any other port is mounted at root and needs no rewriting.
 */
export async function routeToSessionPort(self, port, request, innerPath, mountBase, capability) {
    await self.restorePersistedDevServer?.(port);
    // The durable seam: a request on a port nothing is serving may be a
    // durable application a reset left dead — the alarm pump would re-drive
    // it eventually, but a URL in someone's hands cannot wait for eventually.
    // 'absent' falls through to the honest 502 unchanged; 'started' continues
    // to normal routing with the port freshly bound; 'failed' is mid-launch
    // or a lost boot, so the page re-asks on its own timer.
    if (self.ensureDurableAppOnPort !== undefined) {
        const durable = await self.ensureDurableAppOnPort(port);
        if (durable === 'failed') {
            return new Response(renderPortStartingHtml(port), {
                status: 503,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Retry-After': '3',
                },
            });
        }
    }
    if (capability !== undefined) {
        // A rebuilt supervisor holds a capability nobody was handed; the durable
        // one is the value in circulation, so it wins before the check.
        await restorePortCapability(self, port);
        if (!self.portRegistry.hasCapability(port, capability)) {
            // 404, not 403: a wrong capability must not confirm that the port is
            // listening at all.
            return new Response('Not found', { status: 404 });
        }
        // The public bearer form arrived without a session attach: the
        // capability is real, but it authorises this route only for a port the
        // owner deliberately exposed — the stored visibility is the gate.
        if (request.headers.get(PUBLIC_BEARER_HEADER) !== null) {
            const reservation = await readPortReservation(self.ctx, port);
            if (reservation === null || reservation.visibility !== 'public') {
                return new Response('Not found', { status: 404 });
            }
        }
    }
    if (port === self._viteShimPort) {
        // The preview HMR WebSocket can't cross the port-registry RPC, so it is
        // accepted in-DO for both dev servers — the same handling `/preview/` uses.
        if (self.cirrusReal?.isRunning && self.acceptCirrusHmrWs && isCirrusHmrPath(innerPath)) {
            return self.acceptCirrusHmrWs(request);
        }
        // The Cirrus dev server rewrites base-relative URLs per request and the
        // generic proxy strips the base header, so hand it the request directly.
        if (self.viteDevServer?.isRunning) {
            return self.viteDevServer.handleRequest(request, innerPath, mountBase);
        }
    }
    const proxied = capability === undefined
        ? await self.portRegistry.routeRequest(port, request, innerPath)
        : await self.portRegistry.routeCapabilityRequest(port, capability, request, innerPath);
    if (proxied)
        return proxied;
    return new Response(`No process listening on port ${port}`, { status: 502 });
}
/** Route a capability-authenticated embedder request to a guest HTTP server. */
export function routeCapabilityPort(self, port, capability, request, innerPath) {
    return routeToSessionPort(self, port, request, normalizeForwardedHttpPath(innerPath), '', capability);
}
