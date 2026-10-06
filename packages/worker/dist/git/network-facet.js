/**
 * git/network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - Pre-flush ordinary waves with headroom below W7's 128-path limit or
 *     before 4 MiB via ONE supervisor.writeBatchStream() RPC. Each published
 *     path is atomic; a later publish-group failure may leave a committed prefix.
 *   - Clone prepare durably flushes Git metadata, then a second entrypoint
 *     invocation validates HEAD and flushes the worktree/index.
 *   - Fresh clones carry a metadata-only closed-world overlay across the
 *     invocation boundary; regular-file bytes still fall through after flush.
 *
 * Why this fixes the hang:
 *   - CPU-heavy packfile delta resolution runs in facet (own CPU budget)
 *   - No per-file RPC round-trips — bounded path waves
 *   - Packfile network fetch works (facet fetch is reliable, DO fetch hangs)
 *   - cf-git's nonBlocking=true option yields to event loop between batches
 *
 * See docs/analysis in git-network-facet plan — the canonical write-up lives
 * in the PR that introduced this file.
 */
import { getCtxExports } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { fetchGitBundleSource } from '../runtime/git-bundle-artifact.js';
import { W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE } from '../loaders/generated-workers.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { GIT_PACK_NODE_IMPORTS, GIT_PACK_SRC } from './pack/facet.generated.js';
import { COMMITS_PER_CHUNK, treeSlices } from './pack/history.js';
import { RETRY_ATTEMPTS, isLostTransport, retryDelay } from './pack/transport.js';
/**
 * The clone's job marker, in its git directory from prepare until the clone
 * is whole: the proof an abort needs that the destination is the clone's,
 * and what tells every other git command the repository is not yet one.
 */
export const GIT_CLONE_JOB_MARKER = 'nimbus-clone-job';
const WAVE_DIAGNOSTIC_FIELDS = [
    'waves', 'files', 'bytes', 'rpcWallMs', 'maxRpcWallMs', 'producerWaitMs',
    'ownershipVisits', 'maxWavePaths', 'maxWaveBytes', 'retries',
];
/** The facet's wave writer counters, as it reported them. */
function parseWaveDiagnostic(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const parsed = {
        waves: 0, files: 0, bytes: 0, rpcWallMs: 0, maxRpcWallMs: 0, producerWaitMs: 0,
        ownershipVisits: 0, maxWavePaths: 0, maxWaveBytes: 0, retries: 0,
    };
    for (const field of WAVE_DIAGNOSTIC_FIELDS) {
        parsed[field] = nonNegativeCounter(Reflect.get(value, field));
    }
    return parsed;
}
const CLONE_PHASE_TIMEOUT_MS = 240_000;
const CLONE_ABORT_TIMEOUT_MS = 30_000;
const DEFAULT_CLONE_BUDGET_MS = 30 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const EMPTY_SUPERVISOR_RPC_COUNTERS = {
    stat: 0,
    lstat: 0,
    readdir: 0,
    readFile: 0,
    fsReadRange: 0,
    fsWriteRange: 0,
    rename: 0,
    writeBatchStream: 0,
    readlink: 0,
    symlink: 0,
    legacySymlinkSubtree: 0,
    stdout: 0,
};
const EMPTY_METADATA_OVERLAY_STATS = {
    entries: 0,
    accountedBytes: 0,
    maxEntries: 0,
    maxAccountedBytes: 0,
};
function nonNegativeCounter(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function positiveSafeInteger(value, fallback, label) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return Number(value);
}
function parseGitNetworkErrorCode(value) {
    return value === 'GitCloneBudgetExceeded' ? value : undefined;
}
function parseSupervisorRpcCounters(value) {
    const counters = value && typeof value === 'object'
        ? value
        : {};
    return {
        stat: nonNegativeCounter(counters.stat),
        lstat: nonNegativeCounter(counters.lstat),
        readdir: nonNegativeCounter(counters.readdir),
        readFile: nonNegativeCounter(counters.readFile),
        fsReadRange: nonNegativeCounter(counters.fsReadRange),
        fsWriteRange: nonNegativeCounter(counters.fsWriteRange),
        rename: nonNegativeCounter(counters.rename),
        writeBatchStream: nonNegativeCounter(counters.writeBatchStream),
        readlink: nonNegativeCounter(counters.readlink),
        symlink: nonNegativeCounter(counters.symlink),
        legacySymlinkSubtree: nonNegativeCounter(counters.legacySymlinkSubtree),
        stdout: nonNegativeCounter(counters.stdout),
    };
}
function parseMetadataOverlayStats(value) {
    const stats = value && typeof value === 'object'
        ? value
        : {};
    return {
        entries: nonNegativeCounter(stats.entries),
        accountedBytes: nonNegativeCounter(stats.accountedBytes),
        maxEntries: nonNegativeCounter(stats.maxEntries),
        maxAccountedBytes: nonNegativeCounter(stats.maxAccountedBytes),
    };
}
function addSupervisorRpcCounters(total, value) {
    const counters = parseSupervisorRpcCounters(value);
    for (const key of Object.keys(total)) {
        total[key] += counters[key];
    }
}
function parseLastProgress(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const progress = value;
    if (typeof progress.phase !== 'string')
        return undefined;
    const loaded = nonNegativeCounter(progress.loaded);
    const total = progress.total === undefined
        ? undefined
        : nonNegativeCounter(progress.total);
    return { phase: progress.phase, loaded, total };
}
function parsePhaseDiagnostic(value, fallback, result) {
    const diagnostic = value && typeof value === 'object'
        ? value
        : {};
    const phase = diagnostic.phase === 'clone-prepare' ||
        diagnostic.phase === 'clone-batch' ||
        diagnostic.phase === 'clone-history' ||
        diagnostic.phase === 'clone-finish' ||
        diagnostic.phase === 'clone-abort' ||
        diagnostic.phase === 'operation'
        ? diagnostic.phase
        : fallback.phase;
    const outcome = diagnostic.outcome === 'success' ||
        diagnostic.outcome === 'error' ||
        diagnostic.outcome === 'timeout'
        ? diagnostic.outcome
        : fallback.outcome;
    const supervisorRpc = parseSupervisorRpcCounters(diagnostic.supervisorRpc ?? result.supervisorRpc);
    return {
        phase,
        invocationId: typeof diagnostic.invocationId === 'string'
            ? diagnostic.invocationId
            : fallback.invocationId,
        startedAt: nonNegativeCounter(diagnostic.startedAt) || fallback.startedAt,
        endedAt: nonNegativeCounter(diagnostic.endedAt) || fallback.endedAt,
        elapsed: nonNegativeCounter(diagnostic.elapsed) || fallback.elapsed,
        outcome,
        mutated: typeof diagnostic.mutated === 'boolean'
            ? diagnostic.mutated
            : typeof result.mutated === 'boolean'
                ? result.mutated
                : fallback.mutated,
        error: typeof diagnostic.error === 'string'
            ? diagnostic.error
            : fallback.error,
        lastProgress: parseLastProgress(diagnostic.lastProgress),
        w7Waves: nonNegativeCounter(diagnostic.w7Waves) ||
            supervisorRpc.writeBatchStream,
        supervisorRpc,
        waves: parseWaveDiagnostic(diagnostic.waves),
    };
}
class GitClonePhaseError extends Error {
    phase;
    diagnostic;
    mutated;
    errorCode;
    constructor(phase, message, diagnostic, errorCode) {
        super(message);
        this.name = 'GitClonePhaseError';
        this.phase = phase;
        this.diagnostic = diagnostic;
        this.mutated = diagnostic.mutated;
        this.errorCode = errorCode;
    }
}
class GitCloneBudgetExceededError extends GitClonePhaseError {
    code = 'GitCloneBudgetExceeded';
    budget;
    constructor(phase, budget, diagnostic) {
        super(phase, `git clone budget exhausted after ${budget.batchesCompleted} batches / ` +
            `${budget.filesWritten} files (elapsed=${budget.elapsedMs}ms limit=${budget.limitMs}ms)`, diagnostic, 'GitCloneBudgetExceeded');
        this.name = 'GitCloneBudgetExceededError';
        this.budget = budget;
    }
}
function cloneBudgetDiagnostic(phase, context, now) {
    return {
        phase,
        batchesCompleted: context.batchesCompleted,
        filesWritten: context.filesWritten,
        elapsedMs: Math.max(0, now - context.startedAt),
        limitMs: context.limitMs,
    };
}
async function hashCloneOptions(opts) {
    const immutable = JSON.stringify({
        op: opts.op,
        dir: opts.dir,
        url: opts.url,
        remote: opts.remote ?? 'origin',
        ref: opts.ref ?? null,
        depth: opts.depth ?? null,
        exclusiveDestination: opts.exclusiveDestination === true,
        exclusiveMutationRoot: opts.exclusiveMutationRoot ?? null,
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(immutable));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function phaseErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function invokeFacet(entrypoint, phase, invocationId, body, outerDeadline, phaseLimitMs, budgetContext) {
    const startedAt = Date.now();
    const remaining = outerDeadline - startedAt;
    const timeoutMs = Math.min(phaseLimitMs, remaining);
    if (timeoutMs <= 0) {
        const diagnostic = {
            phase,
            invocationId,
            startedAt,
            endedAt: startedAt,
            elapsed: 0,
            outcome: 'timeout',
            error: `git clone budget exhausted before ${phase}`,
            w7Waves: 0,
            supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
        };
        if (budgetContext) {
            throw new GitCloneBudgetExceededError(phase, cloneBudgetDiagnostic(phase, budgetContext, startedAt), diagnostic);
        }
        throw new GitClonePhaseError(phase, diagnostic.error, diagnostic);
    }
    const controller = new AbortController();
    const phaseDeadline = startedAt + timeoutMs;
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            const outerBudgetLimited = remaining <= phaseLimitMs && budgetContext !== undefined;
            const message = outerBudgetLimited
                ? 'git clone total budget reached during ' + phase
                : `git ${phase} timed out after ${timeoutMs / 1000}s`;
            controller.abort(message);
            if (outerBudgetLimited) {
                const endedAt = Date.now();
                const diagnostic = {
                    phase,
                    invocationId,
                    startedAt,
                    endedAt,
                    elapsed: endedAt - startedAt,
                    outcome: 'timeout',
                    error: message,
                    w7Waves: 0,
                    supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                };
                reject(new GitCloneBudgetExceededError(phase, cloneBudgetDiagnostic(phase, budgetContext, Math.max(endedAt, outerDeadline)), diagnostic));
            }
            else {
                reject(new Error(message));
            }
        }, timeoutMs);
    });
    try {
        const call = entrypoint.fetch(new Request(`http://git/git/${phase}/${encodeURIComponent(invocationId)}`, {
            method: 'POST',
            body: JSON.stringify({ ...body, phase, invocationId, phaseDeadline }),
            signal: controller.signal,
        })).then((response) => {
            if (controller.signal.aborted)
                disposeRpcResource(response);
            return response;
        });
        const response = await Promise.race([call, timeout]);
        let result;
        try {
            result = await response.json();
        }
        finally {
            disposeRpcResource(response);
        }
        const endedAt = Date.now();
        const diagnostic = parsePhaseDiagnostic(result.diagnostic, {
            phase,
            invocationId,
            startedAt,
            endedAt,
            elapsed: endedAt - startedAt,
            outcome: result.success === true ? 'success' : 'error',
            error: typeof result.error === 'string' ? result.error : undefined,
        }, result);
        return { result, diagnostic };
    }
    catch (error) {
        if (error instanceof GitClonePhaseError)
            throw error;
        const endedAt = Date.now();
        const message = phaseErrorMessage(error);
        const diagnostic = {
            phase,
            invocationId,
            startedAt,
            endedAt,
            elapsed: endedAt - startedAt,
            outcome: controller.signal.aborted ? 'timeout' : 'error',
            error: message,
            w7Waves: 0,
            supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
        };
        throw new GitClonePhaseError(phase, message, diagnostic);
    }
    finally {
        if (timeoutHandle !== undefined)
            clearTimeout(timeoutHandle);
    }
}
const GIT_PROGRESS_ENCODER = new TextEncoder();
async function writeClonePhaseProgress(supervisor, diagnostic) {
    try {
        const rpcCount = Object.values(diagnostic.supervisorRpc)
            .reduce((total, count) => total + count, 0);
        const status = diagnostic.outcome === 'success' ? 'complete' : diagnostic.outcome;
        const result = await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(`\n[git] ${diagnostic.phase} ${status} ` +
            `(invocation=${diagnostic.invocationId} wall=${diagnostic.elapsed}ms ` +
            `w7=${diagnostic.w7Waves} rpc=${rpcCount})` +
            (diagnostic.outcome === 'success' || !diagnostic.error ? '' : `: ${diagnostic.error}`) + '\n'));
        disposeRpcResource(result);
    }
    catch {
        // Terminal progress is best-effort; the phase result remains authoritative.
    }
}
/**
 * Batches of a fast clone that run at once. Facets loaded by one session
 * share its thread (measured: four 4.2 s CPU burners took 18.8 s), so more
 * at once buy only overlapping network waits, and each holds its own
 * buffers (two waves of up to 4 MiB, a 4 MiB base cache). Measured
 * 2026-10-05, vscode depth 1 at four: the session object peaked at 207 MiB
 * and was reset (GraphQL fatalInternalErrors 1).
 */
const CLONE_BATCH_CONCURRENCY = 2;
/**
 * Run `items` through `run`, `concurrency` at a time. A failure stops new
 * items; those in flight are awaited before it is thrown, so an abort never
 * races a writer.
 */
async function runPool(items, concurrency, run) {
    let next = 0;
    let failure = null;
    const worker = async () => {
        while (failure === null && next < items.length) {
            const index = next++;
            try {
                await run(items[index], index);
            }
            catch (error) {
                failure ??= error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (failure !== null)
        throw failure;
}
/**
 * A batch or history piece that failed in transit, or hung, is tried again
 * under the one lost-transport policy (pack/transport.ts): seen live as a
 * request to the git server failing (UploadPackError) and a piece hung
 * (react's first batch, three times in five clones). A write wave whose
 * answer is lost is the wave writer's to re-send. Its earlier attempt's
 * temporary pack is discarded.
 */
const CLONE_PIECE_ATTEMPTS = RETRY_ATTEMPTS;
/** A piece takes seconds (Linux's batches ~17 s, react's largest history piece 51 s): one hung this long is retried. */
const CLONE_PIECE_TIMEOUT_MS = 150_000;
function transientPieceFailure(diagnostic, error) {
    return diagnostic.outcome === 'timeout' || isLostTransport(error);
}
/** One fast-clone facet invocation after prepare; its failure is the clone's. */
async function invokeClonePhase(phase, opts, run) {
    let invocation;
    for (let attempt = 1; attempt <= CLONE_PIECE_ATTEMPTS; attempt++) {
        const epoch = run.facets.epoch;
        try {
            invocation = await invokeFacet(run.facets.entrypoint, phase, crypto.randomUUID(), { ...opts, attempt }, run.outerDeadline, phase === 'clone-finish'
                ? CLONE_PHASE_TIMEOUT_MS
                : positiveSafeInteger(opts.pieceTimeoutMs, CLONE_PIECE_TIMEOUT_MS, 'piece timeout'), run.budgetContext);
        }
        catch (error) {
            // A piece that hung (or whose facet call broke) throws rather than answers.
            if (!(error instanceof GitClonePhaseError) || error instanceof GitCloneBudgetExceededError ||
                phase === 'clone-finish' || attempt === CLONE_PIECE_ATTEMPTS ||
                !transientPieceFailure(error.diagnostic, error.message)) {
                throw error;
            }
            if (error.diagnostic.outcome === 'timeout') {
                // It may still be running: its writes lose their authority first.
                if (run.facets.fence === null)
                    throw error;
                if (run.facets.epoch === epoch)
                    run.facets.fence();
            }
            run.phases.push(error.diagnostic);
            if (run.progress) {
                await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error.message}\n`);
            }
            await retryDelay(attempt - 1);
            continue;
        }
        run.phases.push(invocation.diagnostic);
        run.accountResult(invocation.result);
        const error = typeof invocation.result.error === 'string' ? invocation.result.error : '';
        // A fence for another piece revoked this one's writes while it ran.
        const fenced = run.facets.epoch !== epoch;
        if (invocation.result.success === true || phase === 'clone-finish' ||
            !(fenced || transientPieceFailure(invocation.diagnostic, error)))
            break;
        if (run.progress) {
            await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error}\n`);
        }
        if (attempt < CLONE_PIECE_ATTEMPTS)
            await retryDelay(attempt - 1);
    }
    if (invocation.result.success !== true) {
        throw new GitClonePhaseError(phase, typeof invocation.result.error === 'string' ? invocation.result.error : phase + ' failed', invocation.diagnostic);
    }
    return invocation;
}
/** The fast clone after prepare: its blob batches, CLONE_BATCH_CONCURRENCY at a time. Returns the index shares. */
async function runCloneBatches(facetOpts, identity, fast, run, 
/** A streamed clone's batches read their blobs from its stored pack. */
local = false) {
    const shares = [...fast.shares];
    let completed = 0;
    const concurrency = positiveSafeInteger(facetOpts.batchConcurrency, CLONE_BATCH_CONCURRENCY, 'batch concurrency');
    await runPool(fast.batches, concurrency, async (batch) => {
        const invocation = await invokeClonePhase('clone-batch', {
            ...facetOpts, ...identity, batch: { index: batch.index, bytes: batch.bytes }, capabilities: fast.capabilities, partial: fast.partial,
            local: local === true,
        }, run);
        const result = invocation.result.batch;
        if (result === undefined)
            throw new GitClonePhaseError('clone-batch', 'clone-batch returned no batch', invocation.diagnostic);
        shares.push({ name: 'index-' + result.index, bytes: result.indexBytes });
        completed++;
        run.budgetContext.batchesCompleted++;
        run.budgetContext.filesWritten += result.files;
        if (run.progress) {
            await writeCloneProgressLine(run.progress, `\n[git] clone-batch ${completed}/${fast.batches.length} complete (blobs=${result.blobs} files=${result.files} ` +
                (result.pack === null ? '' : `pack=${(result.pack.packBytes / 1048576).toFixed(1)}MB `) +
                `wall=${invocation.diagnostic.elapsed}ms ` +
                `w7=${invocation.diagnostic.w7Waves})\n`);
        }
    });
    return shares;
}
/**
 * History pieces run one at a time: each holds a base cache and a window of
 * stored bytes (~30 MB), and facets count against the session's memory.
 */
const CLONE_HISTORY_CONCURRENCY = 1;
/** A full clone's history (git/pack/history.ts): commits, then trees, then blobs. */
async function runCloneHistory(facetOpts, identity, fast, run) {
    const base = { ...facetOpts, ...identity, capabilities: fast.capabilities };
    let pieces = 0;
    let packBytes = 0;
    const invoke = async (history) => {
        const invocation = await invokeClonePhase('clone-history', { ...base, history }, run);
        const step = invocation.result.history;
        if (step === undefined)
            throw new GitClonePhaseError('clone-history', 'clone-history returned nothing', invocation.diagnostic);
        return { step, elapsed: invocation.diagnostic.elapsed };
    };
    /** A piece, and its continuations while its decoding runs past a budget. */
    const piece = async (kind, name, request) => {
        let { step, elapsed } = await invoke({ step: 'piece', kind, piece: name, ...request });
        const lists = [...step.lists];
        for (let part = 1; step.pending !== null; part++) {
            ({ step, elapsed } = await invoke({ step: 'resume', kind, piece: name, part, pending: step.pending }));
            lists.push(...step.lists);
        }
        pieces++;
        packBytes += step.pack?.packBytes ?? 0;
        if (run.progress) {
            await writeCloneProgressLine(run.progress, `\n[git] clone-history ${name} complete (objects=${step.pack?.objects ?? 0} ` +
                `pack=${((step.pack?.packBytes ?? 0) / 1048576).toFixed(1)}MB wall=${elapsed}ms)\n`);
        }
        return lists;
    };
    const roots = await piece('commits', 'commits', { head: fast.commit });
    const blobLists = [];
    const commitsPerChunk = positiveSafeInteger(facetOpts.historyCommitsPerChunk, COMMITS_PER_CHUNK, 'history commits per chunk');
    const concurrency = positiveSafeInteger(facetOpts.historyConcurrency, CLONE_HISTORY_CONCURRENCY, 'history concurrency');
    await runPool(treeSlices(roots, commitsPerChunk), concurrency, async (source, index) => {
        blobLists.push(...await piece('trees', 'trees-' + index, { source }));
    });
    const plan = await invokeClonePhase('clone-history', {
        ...base,
        history: { step: 'plan', lists: blobLists, present: fast.batches.map((batch) => ({ name: 'batch-' + batch.index, bytes: batch.bytes })) },
    }, run);
    const batches = plan.result.history?.batches ?? [];
    await runPool(batches, concurrency, async (source, index) => {
        await piece('blobs', 'blobs-' + index, { source });
    });
    if (run.progress) {
        await writeCloneProgressLine(run.progress, `\n[git] clone-history complete (${pieces} requests, ${(packBytes / 1048576).toFixed(1)}MB)\n`);
    }
}
/**
 * A streamed clone after prepare: its pack's decoding continued from the
 * stored bytes while it stops at a budget, then the checkout planned from
 * the pack (clone.ts clonePlanFromStore).
 */
async function runCloneSnapshot(facetOpts, identity, stream, run) {
    const base = { ...facetOpts, ...identity, capabilities: [] };
    let pending = stream.pending;
    for (let part = 1; pending !== null; part++) {
        const invocation = await invokeClonePhase('clone-history', {
            ...base, history: { step: 'resume', kind: 'snapshot', piece: 'snapshot', part, pending },
        }, run);
        const step = invocation.result.history;
        if (step === undefined)
            throw new GitClonePhaseError('clone-history', 'clone-history returned nothing', invocation.diagnostic);
        pending = step.pending;
    }
    const plan = await invokeClonePhase('clone-history', {
        ...base, history: { step: 'checkout-plan', commit: stream.commit },
    }, run);
    const planned = plan.result.history;
    if (planned === undefined)
        throw new GitClonePhaseError('clone-history', 'checkout-plan returned nothing', plan.diagnostic);
    return planned;
}
/** The index from the shares; a full clone's shallow file goes; then the marker. */
async function runCloneFinish(facetOpts, identity, shares, full, cacheTreeBytes, tags, run) {
    const finish = await invokeClonePhase('clone-finish', { ...facetOpts, ...identity, shares, full, cacheTreeBytes, tags }, run);
    if (run.progress)
        await writeClonePhaseProgress(run.progress, finish.diagnostic);
}
async function writeCloneProgressLine(supervisor, line) {
    try {
        disposeRpcResource(await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(line)));
    }
    catch {
        // Terminal progress is best-effort; the batch result remains authoritative.
    }
}
/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export async function execGitNetwork(ctx, env, opts) {
    const start = Date.now();
    const timeoutMs = opts.timeout ?? (opts.op === 'clone'
        ? DEFAULT_CLONE_BUDGET_MS
        : DEFAULT_OPERATION_TIMEOUT_MS);
    const outerDeadline = start + timeoutMs;
    try {
        if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
            throw new Error('git network operation requires a positive process pid');
        }
        if (!env?.LOADER?.load) {
            return {
                success: false,
                error: 'env.LOADER.load not available — cannot spawn git facet',
                elapsed: Date.now() - start,
                filesWritten: 0,
                bytesWritten: 0,
                supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
            };
        }
        const { mutationOwner, rotateMutationOwner, ...facetOpts } = opts;
        const ctxExports = getCtxExports();
        const bindingFor = (owner) => ctxExports.SupervisorRPC({
            props: { ...supervisorBindingProps(ctx, opts.pid), mutationOwner: owner },
        });
        const supervisorBinding = ctxExports?.SupervisorRPC ? bindingFor(mutationOwner) : undefined;
        if (!supervisorBinding) {
            return {
                success: false,
                error: 'SupervisorRPC binding not available',
                elapsed: Date.now() - start,
                filesWritten: 0,
                bytesWritten: 0,
                supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
            };
        }
        let worker;
        let entrypoint;
        // Facets a clone's fences loaded after the first (CloneFacets).
        const fencedLoads = [];
        // The unkeyed git worker is one distinct Dynamic Worker in flight on the
        // session's ledger from load to teardown — bracketed, never wrapped (see
        // beginLoaderFetch).
        const endFetch = beginLoaderFetch(ctx, `git-network:${crypto.randomUUID()}`);
        try {
            const gitBundleSource = await fetchGitBundleSource(env);
            const facetCode = (binding) => ({
                compatibilityDate: CF_COMPAT_DATE,
                compatibilityFlags: [...GUEST_COMPAT_FLAGS],
                mainModule: 'git-network-worker.js',
                // Facet gets:
                //   - its own worker code (git-network-worker.js), with the
                //     W7 frame helpers (encodeWriteBatchStream + supporting
                //     state) prepended so the buffered fs adapter can call
                //     them as bare identifiers — the same shape IsolatePool's
                //     `preamble` option provides for npm install. This is the
                //     W7 v3 emits one bounded record per pull; the receiver owns
                //     the aggregate 8 MiB payload-credit and transaction limits.
                //   - the pre-bundled isomorphic-git (git-bundle.js), the staged
                //     copy of vendor/git.generated.mjs (runtime/git-bundle-artifact.ts)
                modules: {
                    'git-network-worker.js': assembleGitNetworkFacetSource(),
                    'git-bundle.js': gitBundleSource,
                },
                env: { SUPERVISOR: binding },
            });
            const loadedWorker = env.LOADER.load(facetCode(supervisorBinding));
            worker = loadedWorker;
            entrypoint = loadedWorker.getEntrypoint();
            if (opts.op === 'clone') {
                const jobId = crypto.randomUUID();
                const optionsHash = await hashCloneOptions(opts);
                const phases = [];
                const supervisorRpc = { ...EMPTY_SUPERVISOR_RPC_COUNTERS };
                let metadataOverlay = { ...EMPTY_METADATA_OVERLAY_STATS };
                let filesWritten = 0;
                let bytesWritten = 0;
                const budgetContext = {
                    startedAt: start,
                    limitMs: timeoutMs,
                    batchesCompleted: 0,
                    filesWritten: 0,
                };
                const facets = {
                    entrypoint,
                    epoch: 0,
                    fence: rotateMutationOwner === undefined ? null : () => {
                        const binding = bindingFor(rotateMutationOwner());
                        const endLoad = beginLoaderFetch(ctx, `git-network:${crypto.randomUUID()}`);
                        const loaded = env.LOADER.load(facetCode(binding));
                        const fresh = loaded.getEntrypoint();
                        fencedLoads.push({ binding, worker: loaded, entrypoint: fresh, endFetch: endLoad });
                        facets.entrypoint = fresh;
                        facets.epoch++;
                    },
                };
                const accountResult = (result) => {
                    filesWritten += nonNegativeCounter(result.filesWritten);
                    bytesWritten += nonNegativeCounter(result.bytesWritten);
                    addSupervisorRpcCounters(supervisorRpc, result.supervisorRpc);
                    const overlay = parseMetadataOverlayStats(result.metadataOverlay);
                    if (overlay.entries > 0 || overlay.accountedBytes > 0) {
                        metadataOverlay = overlay;
                    }
                };
                try {
                    const prepareInvocationId = crypto.randomUUID();
                    const prepare = await invokeFacet(entrypoint, 'clone-prepare', prepareInvocationId, { ...facetOpts, jobId, optionsHash }, outerDeadline, CLONE_PHASE_TIMEOUT_MS, budgetContext);
                    phases.push(prepare.diagnostic);
                    accountResult(prepare.result);
                    if (prepare.result.success !== true ||
                        !prepare.result.prepared ||
                        typeof prepare.result.prepared !== 'object') {
                        throw new GitClonePhaseError('clone-prepare', typeof prepare.result.error === 'string'
                            ? prepare.result.error
                            : 'clone-prepare returned an invalid result', prepare.diagnostic);
                    }
                    if (!opts.quiet)
                        await writeClonePhaseProgress(supervisorBinding, prepare.diagnostic);
                    const prepared = prepare.result.prepared;
                    const run = {
                        facets,
                        outerDeadline,
                        budgetContext,
                        phases,
                        accountResult,
                        progress: opts.quiet ? null : supervisorBinding,
                    };
                    const identity = { jobId, optionsHash };
                    let fast = prepared.fast;
                    if (prepared.stream !== undefined) {
                        // A server without wants by id sent one pack: finish decoding it, then plan the checkout from it.
                        fast = await runCloneSnapshot(facetOpts, identity, prepared.stream, run);
                    }
                    if (fast === undefined)
                        throw new GitClonePhaseError('clone-prepare', 'clone-prepare returned no plan', prepare.diagnostic);
                    const shares = await runCloneBatches(facetOpts, identity, fast, run, prepared.stream !== undefined);
                    const full = facetOpts.depth === undefined;
                    if (full && prepared.fast !== undefined && fast.commit !== null) {
                        await runCloneHistory(facetOpts, identity, fast, run);
                    }
                    const tags = prepared.fast?.tags ?? prepared.stream?.tags ?? [];
                    await runCloneFinish(facetOpts, identity, shares, full, fast.cacheTreeBytes, tags, run);
                    return {
                        success: true,
                        elapsed: Date.now() - start,
                        filesWritten,
                        bytesWritten,
                        supervisorRpc,
                        metadataOverlay,
                        phases,
                    };
                }
                catch (error) {
                    const phaseError = error instanceof GitClonePhaseError
                        ? error
                        : new GitClonePhaseError('clone-prepare', phaseErrorMessage(error), {
                            phase: 'clone-prepare',
                            invocationId: 'unavailable',
                            startedAt: start,
                            endedAt: Date.now(),
                            elapsed: Date.now() - start,
                            outcome: 'error',
                            error: phaseErrorMessage(error),
                            w7Waves: 0,
                            supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                        });
                    if (!phases.some(phase => phase.invocationId === phaseError.diagnostic.invocationId)) {
                        phases.push(phaseError.diagnostic);
                    }
                    let cleanupError;
                    const preMutationPrepareFailure = phaseError.phase === 'clone-prepare' &&
                        phaseError.mutated === false;
                    if (!preMutationPrepareFailure) {
                        try {
                            // A piece of this clone may still be running: its writes lose
                            // their authority before the abort removes what it wrote.
                            facets.fence?.();
                            const abort = await invokeFacet(facets.entrypoint, 'clone-abort', crypto.randomUUID(), { ...facetOpts, jobId, optionsHash }, Date.now() + CLONE_ABORT_TIMEOUT_MS, CLONE_ABORT_TIMEOUT_MS);
                            phases.push(abort.diagnostic);
                            accountResult(abort.result);
                            if (!opts.quiet)
                                await writeClonePhaseProgress(supervisorBinding, abort.diagnostic);
                            if (abort.result.success !== true) {
                                cleanupError = typeof abort.result.error === 'string'
                                    ? abort.result.error
                                    : 'clone-abort failed';
                            }
                        }
                        catch (abortError) {
                            if (abortError instanceof GitClonePhaseError) {
                                phases.push(abortError.diagnostic);
                            }
                            cleanupError = phaseErrorMessage(abortError);
                        }
                    }
                    return {
                        success: false,
                        error: phaseError.message,
                        errorPhase: phaseError.phase,
                        errorCode: phaseError instanceof GitCloneBudgetExceededError
                            ? phaseError.code
                            : phaseError.errorCode,
                        budget: phaseError instanceof GitCloneBudgetExceededError
                            ? phaseError.budget
                            : undefined,
                        cleanupError,
                        elapsed: Date.now() - start,
                        filesWritten,
                        bytesWritten,
                        supervisorRpc,
                        metadataOverlay,
                        phases,
                    };
                }
            }
            const invocationId = crypto.randomUUID();
            const startedAt = Date.now();
            const remaining = outerDeadline - startedAt;
            if (remaining <= 0) {
                throw new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`);
            }
            let timeoutHandle;
            const timeout = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`)), remaining);
            });
            const call = entrypoint.fetch(new Request('http://git/op', {
                method: 'POST',
                body: JSON.stringify({ ...facetOpts, invocationId }),
            })).then(async (response) => {
                try {
                    return await response.json();
                }
                finally {
                    disposeRpcResource(response);
                }
            });
            let result;
            try {
                result = await Promise.race([call, timeout]);
            }
            finally {
                if (timeoutHandle !== undefined)
                    clearTimeout(timeoutHandle);
            }
            const endedAt = Date.now();
            const diagnostic = parsePhaseDiagnostic(result.diagnostic, {
                phase: 'operation',
                invocationId,
                startedAt,
                endedAt,
                elapsed: endedAt - startedAt,
                outcome: result.success === true ? 'success' : 'error',
                error: typeof result.error === 'string' ? result.error : undefined,
            }, result);
            return {
                success: result.success === true,
                error: typeof result.error === 'string' ? result.error : undefined,
                errorPhase: result.success === true ? undefined : 'operation',
                elapsed: Date.now() - start,
                filesWritten: nonNegativeCounter(result.filesWritten),
                bytesWritten: nonNegativeCounter(result.bytesWritten),
                supervisorRpc: parseSupervisorRpcCounters(result.supervisorRpc),
                metadataOverlay: parseMetadataOverlayStats(result.metadataOverlay),
                phases: [diagnostic],
                fetchedObjects: result.fetched && typeof result.fetched === 'object' && 'fetched' in result.fetched
                    ? nonNegativeCounter(result.fetched.fetched)
                    : undefined,
            };
        }
        finally {
            // Tear down the facet's RPC stubs regardless of success / timeout.
            // `entrypoint` and `worker` are both cross-isolate stubs; disposing
            // them lets workerd reclaim the dynamic worker's memory eagerly.
            // `supervisorBinding` is the SupervisorRPC stub we minted above —
            // it's from ctxExports (local to the supervisor's own isolate) so
            // in theory it doesn't leak across isolates, but disposing is cheap
            // and symmetric with how the facet's env.SUPERVISOR is handled on
            // the other side.
            disposeRpcResource(entrypoint);
            disposeRpcResource(worker);
            disposeRpcResource(supervisorBinding);
            for (const load of fencedLoads) {
                disposeRpcResource(load.entrypoint);
                disposeRpcResource(load.worker);
                disposeRpcResource(load.binding);
                load.endFetch();
            }
            endFetch();
        }
    }
    catch (e) {
        return {
            success: false,
            error: e?.message || String(e),
            elapsed: Date.now() - start,
            filesWritten: 0,
            bytesWritten: 0,
            supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
            metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
        };
    }
}
/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v3.
 */
export function assembleGitNetworkFacetSource() {
    return GIT_PACK_NODE_IMPORTS + '\n' + W7_FRAME_PREAMBLE + '\n' + WAVE_WRITER_PREAMBLE + '\n' + GIT_PACK_SRC + '\n' +
        generateGitNetworkFacetCode();
}
function generateGitNetworkFacetCode() {
    return `
// Must precede the .toString() embeds below, whose bodies call __name(...).
${ESBUILD_NAME_GLOBAL_SHIM}

const WHOLE_FILE_RPC_SAFE_BYTES = ${MAX_RPC_SAFE_PAYLOAD_BYTES};
const READ_RANGE_BYTES = 4 * 1024 * 1024;
const METADATA_MAX_ENTRIES = 100_000;
const METADATA_MAX_ACCOUNTED_BYTES = 32 * 1024 * 1024;
const METADATA_ENTRY_OVERHEAD_BYTES = 256;
const CLONE_JOB_MARKER = ${JSON.stringify(GIT_CLONE_JOB_MARKER)};
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;


function protocolError(message) {
  return new Error('git clone protocol: ' + message);
}

function requireProtocolString(value, label, maxLength = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requireOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requireMetadataNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requirePositiveMetadataNumber(value, label) {
  const number = requireMetadataNumber(value, label);
  if (number === 0) throw protocolError(label + ' is invalid');
  return number;
}

function cloneJobMarkerPath(dir) {
  return normalizePath(dir) + '/.git/' + CLONE_JOB_MARKER;
}

/** The marker a clone's phases write first: it names the job that owns .git. */
function cloneJobMarker(opts) {
  return JSON.stringify({ version: 1, jobId: opts.jobId, optionsHash: opts.optionsHash });
}

/** Whether .git carries this job's marker (an abort deletes only its own clone). */
async function ownsCloneJob(fs, opts) {
  let raw;
  try {
    raw = await fs.promises.readFile(cloneJobMarkerPath(opts.dir), { encoding: 'utf8' });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
  let marker;
  try { marker = JSON.parse(raw); }
  catch { return false; }
  return !!marker && marker.jobId === opts.jobId && marker.optionsHash === opts.optionsHash;
}

function disposeRpcResult(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === 'function') { try { dispose.call(value); } catch {} }
}

async function useRpcResult(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { disposeRpcResult(value); }
}

// normalizePath is provided by the W7 frame preamble (from _shared/w7-frame.ts),
// prepended to this facet worker — semantically identical, do not redeclare.

function parentOf(p) {
  return p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
}

// fs.promises.readFile takes its encoding bare as well as on an options
// object, and cf-git uses both spellings. Honouring only the object form
// hands text call sites raw bytes; see the supervisor-side adapter in
// ./commands.ts for what that silently cost .gitignore.
function wantsUtf8(options) {
  const encoding = typeof options === 'string' ? options : (options && options.encoding);
  return encoding === 'utf8' || encoding === 'utf-8';
}

function enoent(filepath) {
  const err = new Error('ENOENT: no such file or directory, ' + filepath);
  err.code = 'ENOENT'; err.errno = -2;
  return err;
}

function enotdir(filepath) {
  const err = new Error('ENOTDIR: not a directory, ' + filepath);
  err.code = 'ENOTDIR'; err.errno = -20;
  return err;
}

function eisdir(filepath) {
  const err = new Error('EISDIR: illegal operation on a directory, ' + filepath);
  err.code = 'EISDIR'; err.errno = -21;
  return err;
}

function enotempty(filepath) {
  const err = new Error('ENOTEMPTY: directory not empty, ' + filepath);
  err.code = 'ENOTEMPTY'; err.errno = -39;
  return err;
}

function einval(filepath) {
  const err = new Error('EINVAL: invalid argument, ' + filepath);
  err.code = 'EINVAL'; err.errno = -22;
  return err;
}

function eio(filepath, detail) {
  const err = new Error('EIO: failed to read ' + filepath + ': ' + detail);
  err.code = 'EIO'; err.errno = -5;
  return err;
}

function eloop(filepath) {
  const err = new Error('ELOOP: too many symbolic links encountered, ' + filepath);
  err.code = 'ELOOP'; err.errno = -40;
  return err;
}

function statObj(metadata, followSymlink) {
  const isLink = metadata.kind === 'symlink' && !followSymlink;
  const isDir = metadata.kind === 'dir';
  const isFile = metadata.kind === 'file' || (metadata.kind === 'symlink' && followSymlink);
  const mtimeMs = metadata.mtimeMs;
  const ctimeMs = metadata.ctimeMs;
  const atimeMs = metadata.atimeMs;
  return {
    isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => isLink,
    size: metadata.size,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) | (metadata.mode & 0o7777),
    type: isLink ? 'symlink' : isDir ? 'dir' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function convertSupervisorStat(st) {
  if (!st) return null;
  const mtimeMs = Number(st.mtime) || Date.now();
  const ctimeMs = Number(st.ctime) || mtimeMs;
  const atimeMs = Number(st.atime) || mtimeMs;
  const isDir = st.type === 'directory' || st.type === 'dir';
  const isLink = st.type === 'symlink';
  return {
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
    size: Number(st.size) || 0,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) |
      ((Number(st.mode) || (isDir ? 0o755 : isLink ? 0o777 : 0o644)) & 0o7777),
    type: isDir ? 'dir' : isLink ? 'symlink' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    // The supervisor's git reports these same fields, so an index either side wrote stays warm.
    uid: Number(st.uid) || 0, gid: Number(st.gid) || 0,
    dev: Number(st.dev) || 0, ino: Number(st.ino) || 0, nlink: 1,
  };
}

function metadataFromSupervisorStat(st) {
  if (!st) return null;
  const converted = convertSupervisorStat(st);
  return {
    kind: converted.isDirectory() ? 'dir' : converted.isSymbolicLink() ? 'symlink' : 'file',
    size: converted.size,
    mode: converted.mode & 0o7777,
    mtimeMs: converted.mtimeMs,
    ctimeMs: converted.ctimeMs,
    atimeMs: converted.atimeMs,
  };
}

function createSupervisorRpcCounters() {
  return {
    stat: 0, lstat: 0, readdir: 0, readFile: 0,
    fsReadRange: 0, fsWriteRange: 0, rename: 0, writeBatchStream: 0, readlink: 0, symlink: 0,
    legacySymlinkSubtree: 0, stdout: 0,
  };
}

function emptyMetadataOverlayStats() {
  return {
    entries: 0,
    accountedBytes: 0,
    maxEntries: METADATA_MAX_ENTRIES,
    maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
  };
}

/**
 * A piece's earlier attempts may have left a partial temporary pack (each
 * attempt names its own): it goes before the piece runs again. What the
 * failed attempt published otherwise (files, a named pack) is the same
 * content addressed by the same names, which this attempt rewrites.
 */
async function discardEarlierAttempts(context, opts, prefix, suffix) {
  if (!(opts.attempt > 1)) return;
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  for (let attempt = 1; attempt < opts.attempt; attempt++) {
    const name = opts.jobId + (attempt > 1 ? '_' + attempt : '') + suffix;
    await writer.remove('.git/objects/pack/' + prefix + name);
    // Its idx and rev, if it reached install.ts.
    await writer.remove('.git/objects/pack/tmp_idx_' + name);
    await writer.remove('.git/objects/pack/tmp_rev_' + name);
  }
  await writer.flush();
}

/** The supervisor's ranged calls, counted, as git/pack/facet-packs.ts takes them. */
function facetPacksSupervisor(supervisor, stats, ensureDirectory) {
  // Paths reach the supervisor as this facet's fs sends them: normalized.
  const counted = (name, call) => {
    stats.supervisorRpc[name]++;
    return useRpcResult(call(), (result) => result);
  };
  return {
    // Pack bytes bypass the session's content cache: a cached range pins its
    // chunks in the session's heap (512 x 64 KiB), which the clone shares.
    fsReadRange: (path, offset, length) => counted('fsReadRange', () => supervisor.fsReadRangeUncached(normalizePath(path), offset, length)),
    fsWriteRange: (path, offset, bytes) => counted('fsWriteRange', () => supervisor.fsWriteRange(normalizePath(path), offset, bytes)),
    fsTruncate: (path, size) => counted('fsWriteRange', () => supervisor.fsTruncate(normalizePath(path), size)),
    rename: (from, to) => counted('rename', () => supervisor.rename(normalizePath(from), normalizePath(to))),
    unlink: (path) => counted('rename', () => supervisor.unlink(normalizePath(path))),
    ensureDirectory,
    async readdir(path) {
      stats.supervisorRpc.readdir++;
      try {
        const entries = await useRpcResult(supervisor.readdir(normalizePath(path)), (result) => result);
        return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * What git/pack/clone.ts needs of this facet: the supervisor's ranged writes
 * (under the clone's lease, which the binding presents), and wave writers
 * rooted at the clone that report each published wave's receipts.
 */
function gitPackContext(supervisor, stats, opts, root, deadline, log, worktreeRoot = null) {
  const dir = normalizePath(opts.dir);
  const counted = (name, call) => {
    stats.supervisorRpc[name]++;
    return useRpcResult(call(), (result) => result);
  };
  // A pack's ranged writes, as its waves (the wave writer's deadline), stop at the phase deadline.
  const mutation = (name, call) => {
    if (deadline !== null && Date.now() >= deadline) {
      return Promise.reject(new Error('git ' + (opts.phase || opts.op) + ' passed its phase deadline'));
    }
    return counted(name, call);
  };
  return {
    supervisor: {
      fsWriteRange: (path, offset, bytes) => mutation('fsWriteRange', () => supervisor.fsWriteRange(path, offset, bytes)),
      fsTruncate: (path, size) => mutation('fsWriteRange', () => supervisor.fsTruncate(path, size)),
      fsReadRange: (path, offset, length) => counted('fsReadRange', () => supervisor.fsReadRangeUncached(path, offset, length)),
      rename: (from, to) => mutation('rename', () => supervisor.rename(from, to)),
      async readdir(path) {
        stats.supervisorRpc.readdir++;
        try {
          const entries = await useRpcResult(supervisor.readdir(normalizePath(path)), (result) => result);
          return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
        } catch {
          return [];
        }
      },
    },
    writer(onReceipts) {
      return __nimbusWaveWriter.createWaveWriter({
        supervisor: {
          writeBatchStream(stream) {
            stats.supervisorRpc.writeBatchStream++;
            return supervisor.writeBatchStream(stream);
          },
        },
        root,
        worktreeRoot,
        base: dir,
        deadline,
        onWave(report) {
          stats.filesWritten += report.files;
          stats.bytesWritten += report.bytes;
          if (onReceipts) onReceipts(report.receipts);
        },
      });
    },
    dir,
    url: opts.url,
    auth: opts.auth,
    marker: { path: '.git/' + CLONE_JOB_MARKER, text: cloneJobMarker(opts) },
    onProgress: (line) => log('remote: ' + line + '\\n'),
  };
}

/**
 * Create the buffered fs adapter isomorphic-git will use.
 * Writes buffer in-memory; reads check buffer then fall back to supervisor.
 *
 * Every write is a record for the wave writer (__nimbusWaveWriter, from
 * @nimbus-sh/platform src/wave-writer.ts), which publishes them in W7 waves, one in flight
 * while the next buffers. The adapter keeps the closed-world metadata
 * overlay a clone reads back; the writer keeps the buffered bytes.
 *
 * With a worktreeRoot (fetch, pull, push in an existing repository) the
 * adapter writes that worktree the way git's checkout does (entry.c
 * create_directories, has_symlink_leading_path): below its top, .git
 * aside, a leading component that is not a real directory (a link, dangling
 * or not, or a file) is deleted and replaced by a directory rather than
 * followed, and a file replaces a link at its own path rather than writing
 * through it.
 */
function createBufferedFs(
  supervisor,
  stats,
  authoritativeRoot,
  authoritativeRootMetadata,
  phaseDeadline = null,
  worktreeRoot = null,
) {
  const metadata = new Map();
  const children = new Map();
  const textEncoder = new TextEncoder();
  let metadataAccountedBytes = 0;
  let overlayFailure = null;
  let mutationQueue = Promise.resolve();

  function stampEntry(entry, mtimeMs) {
    entry.atimeMs = mtimeMs;
    entry.mtimeMs = mtimeMs;
    entry.ctimeMs = mtimeMs;
  }

  // Each record carries its overlay metadata (fetch and pull have no other
  // record of a buffered file); a cut stamps the wave's mtime on it, so the
  // overlay's stat agrees with what the wave publishes.
  const writer = __nimbusWaveWriter.createWaveWriter({
    supervisor: {
      writeBatchStream(stream, fence) {
        stats.supervisorRpc.writeBatchStream++;
        return supervisor.writeBatchStream(stream, fence);
      },
    },
    root: authoritativeRoot,
    worktreeRoot,
    deadline: phaseDeadline,
    directoryMode(path) {
      const entry = metadata.get(path);
      return entry && entry.kind === 'dir' ? entry.mode : undefined;
    },
    onCut(cut) {
      for (const dir of cut.directories) {
        const entry = metadata.get(dir);
        if (entry && entry.kind === 'dir') stampEntry(entry, cut.mtimeMs);
      }
      for (const file of cut.files) {
        const entry = file.meta || metadata.get(file.path);
        if (entry && (entry.kind === 'file' || entry.kind === 'symlink')) stampEntry(entry, cut.mtimeMs);
      }
    },
    onWave(report) {
      stats.filesWritten += report.files;
      stats.bytesWritten += report.bytes;
    },
    onResend(lost) {
      console.warn('[git] write wave re-sent', JSON.stringify(lost));
    },
  });

  function assertFlushHealthy() {
    if (overlayFailure) throw overlayFailure;
    writer.assertHealthy();
  }

  async function awaitPendingFlush() {
    await writer.settled();
    assertFlushHealthy();
  }

  // No read reports a link, or resolves through one, before the link is
  // durable: a read waits out every link written and not yet published.
  async function awaitPublishedSymlinks() {
    if (writer.hasUnpublishedSymlinks) await flushWave();
  }

  // A read the overlay cannot answer goes to the supervisor, which must
  // already hold every write the adapter has made.
  async function awaitSupervisorReadable() {
    await awaitPublishedSymlinks();
    await awaitPendingFlush();
  }

  async function flushWave() {
    if (overlayFailure) throw overlayFailure;
    await writer.flush();
  }

  function isAuthoritativePath(path) {
    return authoritativeRoot !== null &&
      (path === authoritativeRoot || path.startsWith(authoritativeRoot + '/'));
  }

  function metadataCost(path, entry) {
    const targetBytes = entry.kind === 'symlink'
      ? textEncoder.encode(entry.target).byteLength
      : 0;
    return METADATA_ENTRY_OVERHEAD_BYTES + textEncoder.encode(path).byteLength + targetBytes;
  }

  function addChild(path) {
    const parent = parentOf(path);
    let names = children.get(parent);
    if (!names) children.set(parent, names = new Set());
    const name = path.slice(parent ? parent.length + 1 : 0);
    if (name) names.add(name);
  }

  function removeChild(path) {
    const parent = parentOf(path);
    const names = children.get(parent);
    if (!names) return;
    const name = path.slice(parent ? parent.length + 1 : 0);
    names.delete(name);
    if (names.size === 0) children.delete(parent);
  }

  function setMetadata(path, entry) {
    if (!isAuthoritativePath(path)) return;
    const previous = metadata.get(path);
    const previousCost = previous ? metadataCost(path, previous) : 0;
    const nextCost = metadataCost(path, entry);
    const nextEntries = metadata.size + (previous ? 0 : 1);
    const nextBytes = metadataAccountedBytes - previousCost + nextCost;
    if (nextEntries > METADATA_MAX_ENTRIES || nextBytes > METADATA_MAX_ACCOUNTED_BYTES) {
      const error = new Error(
        'git clone metadata overlay exceeded its bound (' + nextEntries + ' entries, ' +
        nextBytes + ' accounted bytes)',
      );
      overlayFailure = error;
      throw error;
    }
    metadata.set(path, entry);
    metadataAccountedBytes = nextBytes;
    if (!previous) addChild(path);
    if (entry.kind === 'dir' && !children.has(path)) children.set(path, new Set());
  }

  function removeMetadata(path, recursive) {
    if (!isAuthoritativePath(path)) return;
    const paths = [path];
    if (recursive) {
      for (let index = 0; index < paths.length; index++) {
        const parent = paths[index];
        for (const name of children.get(parent) || []) {
          paths.push(parent + '/' + name);
        }
      }
    }
    paths.sort((left, right) => right.length - left.length);
    for (const candidate of paths) {
      const previous = metadata.get(candidate);
      if (!previous) continue;
      metadataAccountedBytes -= metadataCost(candidate, previous);
      metadata.delete(candidate);
      children.delete(candidate);
      removeChild(candidate);
    }
  }

  function ensureMetadataParents(path, timestamp) {
    if (!isAuthoritativePath(path)) return;
    let parent = parentOf(path);
    while (isAuthoritativePath(parent)) {
      if (!metadata.has(parent)) {
        setMetadata(parent, {
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: timestamp, ctimeMs: timestamp, atimeMs: timestamp,
        });
      }
      if (parent === authoritativeRoot) break;
      parent = parentOf(parent);
    }
  }

  function recordDirectory(path) {
    if (!isAuthoritativePath(path)) return;
    const existing = metadata.get(path);
    if (existing && existing.kind === 'dir') return;
    const now = Date.now();
    ensureMetadataParents(path, now);
    setMetadata(path, {
      kind: 'dir', size: 0, mode: 0o755,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    });
  }

  function resolveMetadataPath(path, followFinal = true) {
    const seen = new Set();
    let current = normalizePath(path);
    for (let depth = 0; depth < 40; depth++) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '';
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        prefix = prefix ? prefix + '/' + parts[index] : parts[index];
        const entry = metadata.get(prefix);
        if (!entry) continue;
        const isFinal = index === parts.length - 1;
        if (entry.kind === 'symlink' && (followFinal || !isFinal)) {
          if (seen.has(prefix)) throw eloop(path);
          seen.add(prefix);
          const target = entry.target.startsWith('/')
            ? normalizePath(entry.target)
            : normalizePath(parentOf(prefix) + '/' + entry.target);
          const remainder = parts.slice(index + 1).join('/');
          current = remainder ? normalizePath(target + '/' + remainder) : target;
          followed = true;
          break;
        }
        if (!isFinal && entry.kind !== 'dir') throw enotdir(path);
      }
      if (!followed) return { path: current, entry: metadata.get(current) };
    }
    throw eloop(path);
  }

  function overlayStats() {
    return {
      entries: metadata.size,
      accountedBytes: metadataAccountedBytes,
      maxEntries: METADATA_MAX_ENTRIES,
      maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
    };
  }

  if (authoritativeRoot !== null && authoritativeRootMetadata) {
    setMetadata(authoritativeRoot, authoritativeRootMetadata);
  }

  // alreadyDurable records that these exact bytes are known to be durably
  // published at path (the caller read them back), so waves can assert the
  // pin's presence without ever re-writing unchanged content.
  function pinFile(path, data, alreadyDurable = false) {
    writer.setPin(normalizePath(path), data, alreadyDurable);
  }

  function unpinFile(path) {
    writer.clearPin(normalizePath(path));
  }

  // Mutations apply in call order: each waits for the one before it, and the
  // writer admits its record (cutting a wave first when it would not fit).
  function bufferMutation(mutate) {
    const operation = mutationQueue.then(async () => {
      assertFlushHealthy();
      return mutate();
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // A file the writer holds, or a stat of one, for a path no wave has published.
  function bufferedStat(path, followSymlink) {
    const buffered = writer.bufferedRecord(path);
    if (!buffered) return null;
    const now = Date.now();
    return statObj(buffered.meta || {
      kind: buffered.kind, size: buffered.size, mode: 0o644,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    }, followSymlink);
  }

  function bufferedDirectoryStat(followSymlink) {
    const now = Date.now();
    return statObj({
      kind: 'dir', size: 0, mode: 0o755,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    }, followSymlink);
  }

  function readBuffered(path, opts) {
    const data = writer.buffered(path);
    if (data === undefined) return undefined;
    return wantsUtf8(opts) ? new TextDecoder().decode(data) : data;
  }

  const fs = {
    promises: {
      async readFile(filepath, opts) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        // Check buffer first (insertion order preserves what git wrote)
        const buffered = readBuffered(p, opts);
        if (buffered !== undefined) return buffered;
        if (writer.isBufferedDelete(p)) throw enoent(filepath);
        const resolved = resolveMetadataPath(p);
        const durablePath = resolved.path;
        if (durablePath !== p) {
          const target = readBuffered(durablePath, opts);
          if (target !== undefined) return target;
        }
        if (resolved.entry && resolved.entry.kind === 'dir') throw enoent(filepath);
        if (!resolved.entry && isAuthoritativePath(durablePath)) throw enoent(filepath);

        // Fall through to the supervisor. Ordinary RPC values have a 32 MiB
        // structured-clone ceiling, so reconstruct larger files through the
        // existing bounded range RPC instead of sending one oversized value.
        // This is intentionally size-based rather than pack-path-specific: it
        // preserves the fs.readFile contract for every large binary file.
        await awaitSupervisorReadable();
        let size = resolved.entry && resolved.entry.kind === 'file'
          ? resolved.entry.size
          : null;
        if (size === null) {
          stats.supervisorRpc.stat++;
          size = await useRpcResult(
            supervisor.stat(durablePath),
            (result) => result === null || result === undefined ? null : Number(result.size),
          );
        }
        if (size === null) throw enoent(filepath);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw eio(filepath, 'invalid file size ' + String(size));
        }

        let data;
        if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
          data = new Uint8Array(size);
          for (let offset = 0; offset < size;) {
            const expected = Math.min(READ_RANGE_BYTES, size - offset);
            stats.supervisorRpc.fsReadRange++;
            const bytesRead = await useRpcResult(
              supervisor.fsReadRange(durablePath, offset, expected),
              (result) => {
                if (result === null || result === undefined) {
                  throw eio(filepath, 'range ' + offset + '..' + (offset + expected) + ' is missing');
                }
                const chunk = result instanceof Uint8Array ? result : new Uint8Array(result);
                if (chunk.byteLength !== expected) {
                  throw eio(
                    filepath,
                    'range ' + offset + '..' + (offset + expected) +
                      ' returned ' + chunk.byteLength + ' bytes',
                  );
                }
                data.set(chunk, offset);
                return chunk.byteLength;
              },
            );
            offset += bytesRead;
          }
        } else {
          stats.supervisorRpc.readFile++;
          data = await useRpcResult(supervisor.readFileBytes(durablePath), (result) => {
            if (result === null || result === undefined) throw enoent(filepath);
            const content = result instanceof Uint8Array ? result : new Uint8Array(result);
            return content.slice();
          });
        }
        if (wantsUtf8(opts)) return new TextDecoder().decode(data);
        return data;
      },

      async writeFile(filepath, data, opts) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        // Every buffered record owns its ArrayBuffer: the W7 stream transfers
        // what it enqueues, and isomorphic-git hands writeFile subarray views
        // of a pack-sized parent, and pako's pooled output as whole views of
        // a shared buffer (both detached a later wave in production). So the
        // bytes are copied here, once, unconditionally.
        let buf;
        if (typeof data === 'string') {
          buf = new TextEncoder().encode(data); // fresh ArrayBuffer
        } else {
          const src = data instanceof Uint8Array ? data : new Uint8Array(data);
          buf = new Uint8Array(src.length);
          buf.set(src);
        }
        return bufferMutation(async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const mode = opts && (Number(opts.mode) & 0o111) ? 0o755 : 0o644;
          const fileMetadata = {
            kind: 'file', size: buf.length, mode,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, fileMetadata);
          await writer.file(p, mode, buf, fileMetadata);
        });
      },

      // unlink(2) and rmdir(2): a buffered delete removes the whole subtree at
      // its path, so neither may take a directory it would not take on disk.
      // unlink refuses a directory; rmdir refuses a non-directory and a
      // directory that still holds anything (untracked files a checkout leaves).
      async unlink(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if ((await fs.promises.lstat(filepath)).isDirectory()) throw eisdir(filepath);
        return bufferMutation(async () => {
          removeMetadata(p, false);
          await writer.remove(p);
        });
      },

      async readdir(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        const local = resolved.entry;
        if (local || isAuthoritativePath(resolved.path)) {
          if (!local) throw enoent(filepath);
          if (local.kind !== 'dir') throw enotdir(filepath);
          return [...(children.get(resolved.path) || [])];
        }
        await awaitSupervisorReadable();
        // Start with supervisor's view
        let names = [];
        stats.supervisorRpc.readdir++;
        const entries = await useRpcResult(supervisor.readdir(resolved.path), (result) => result);
        names = Array.isArray(entries) ? entries.map(e => e.name) : [];
        const set = new Set(names);
        // Add buffered children: anything whose parent == p
        const prefix = resolved.path ? resolved.path + '/' : '';
        const buffered = writer.bufferedPaths();
        for (const paths of [buffered.files, buffered.directories]) {
          for (const bp of paths) {
            if (!bp.startsWith(prefix)) continue;
            const rest = bp.slice(prefix.length);
            if (!rest) continue;
            const firstSeg = rest.split('/')[0];
            if (firstSeg) set.add(firstSeg);
          }
        }
        // Remove deleted
        for (const dp of buffered.deletes) {
          if (!dp.startsWith(prefix)) continue;
          const rest = dp.slice(prefix.length);
          if (rest.indexOf('/') < 0) set.delete(rest);
        }
        return [...set];
      },

      async mkdir(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if (!p) return;
        return bufferMutation(async () => {
          recordDirectory(p);
          await writer.directory(p);
        });
      },

      async rmdir(filepath, options) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if (!(options && options.recursive)) {
          if (!(await fs.promises.lstat(filepath)).isDirectory()) throw enotdir(filepath);
          if ((await fs.promises.readdir(filepath)).length > 0) throw enotempty(filepath);
        }
        return bufferMutation(async () => {
          removeMetadata(p, true);
          await writer.remove(p, true);
        });
      },

      async rm(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        return bufferMutation(async () => {
          removeMetadata(p, true);
          await writer.remove(p, true);
        });
      },

      async stat(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        if (resolved.entry) return statObj(resolved.entry, true);
        if (isAuthoritativePath(resolved.path)) {
          throw enoent(filepath);
        }
        const buffered = bufferedStat(p, true);
        if (buffered) return buffered;
        if (writer.isBufferedDirectory(p)) return bufferedDirectoryStat(true);
        if (writer.isBufferedDelete(p)) throw enoent(filepath);
        if (!p) return bufferedDirectoryStat(true);
        await awaitSupervisorReadable();
        stats.supervisorRpc.stat++;
        const st = await useRpcResult(supervisor.stat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async lstat(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local) return statObj(local, false);
        if (isAuthoritativePath(resolved.path)) {
          throw enoent(filepath);
        }
        const buffered = bufferedStat(resolved.path, false);
        if (buffered) return buffered;
        if (writer.isBufferedDirectory(resolved.path)) return bufferedDirectoryStat(false);
        if (writer.isBufferedDelete(resolved.path)) throw enoent(filepath);
        if (!resolved.path) return bufferedDirectoryStat(false);
        await awaitSupervisorReadable();
        stats.supervisorRpc.lstat++;
        const st = await useRpcResult(supervisor.lstat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async chmod() { /* no-op */ },
      async symlink(target, filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        const value = String(target);
        return bufferMutation(async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const linkMetadata = {
            kind: 'symlink', target: value,
            size: textEncoder.encode(value).byteLength,
            mode: 0o777,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, linkMetadata);
          await writer.symlink(p, value, linkMetadata);
        });
      },
      async readlink(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local && local.kind === 'symlink') return local.target;
        if (local) throw einval(filepath);
        if (isAuthoritativePath(resolved.path)) throw enoent(filepath);
        await awaitSupervisorReadable();
        stats.supervisorRpc.readlink++;
        return useRpcResult(supervisor.readlink(resolved.path), result => {
          if (result === null || result === undefined) throw enoent(filepath);
          return String(result);
        });
      },
    },
  };

  return {
    fs,
    flushWave,
    overlayStats,
    pinFile,
    unpinFile,
    waveStats: () => writer.stats(),
  };
}

export default {
  async fetch(request, workerEnv) {
    const supervisor = workerEnv && workerEnv.SUPERVISOR;
    if (!supervisor) {
      return Response.json({
        success: false, error: 'SUPERVISOR binding missing in facet env',
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 500 });
    }

    let opts;
    try {
      opts = await request.json();
    } catch (e) {
      return Response.json({
        success: false, error: 'Invalid request body: ' + (e && e.message),
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 400 });
    }

    const phase = opts.phase === 'clone-prepare' ||
        opts.phase === 'clone-batch' ||
        opts.phase === 'clone-history' ||
        opts.phase === 'clone-finish' ||
        opts.phase === 'clone-abort'
      ? opts.phase
      : 'operation';
    const invocationId = typeof opts.invocationId === 'string'
      ? opts.invocationId
      : 'unavailable';
    const startedAt = Date.now();
    const startedMonotonic = performance.now();
    const stats = {
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: createSupervisorRpcCounters(),
    };
    let mutated = false;
    let lastProgress = null;
    const respond = (success, payload = {}, status = 200) => {
      const endedAt = Date.now();
      const error = !success && typeof payload.error === 'string'
        ? payload.error
        : undefined;
      return Response.json({
        success,
        ...payload,
        mutated,
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        supervisorRpc: stats.supervisorRpc,
        diagnostic: {
          phase,
          invocationId,
          startedAt,
          endedAt,
          elapsed: Math.max(0, Math.round(performance.now() - startedMonotonic)),
          outcome: success ? 'success' : 'error',
          mutated,
          error,
          lastProgress,
          w7Waves: stats.supervisorRpc.writeBatchStream,
          supervisorRpc: stats.supervisorRpc,
          waves: waveStats(),
        },
      }, { status });
    };
    if (phase !== 'operation') {
      const expectedPath = '/git/' + phase + '/' + encodeURIComponent(invocationId);
      if (new URL(request.url).pathname !== expectedPath) {
        return respond(false, {
          error: 'git clone protocol: request trace marker does not match its phase identity',
          metadataOverlay: emptyMetadataOverlayStats(),
        }, 400);
      }
    }
    const log = (msg) => {
      if (opts.quiet) return;
      stats.supervisorRpc.stdout++;
      try { useRpcResult(supervisor.stdout(new TextEncoder().encode(msg)), () => undefined).catch(() => {}); } catch {}
    };

    // Import the pre-bundled isomorphic-git + http/web.
    // The bundle is provided via LOADER.load()'s modules record;
    // see scripts/bundle-git.mjs and src/runtime/git-bundle-artifact.ts.
    let git, http;
    try {
      const bundle = await import('./git-bundle.js');
      git = bundle.git;
      // http/web has both { request } named and { default: { request } };
      // the namespace bundle.gitHttp exposes request directly, which is
      // what isomorphic-git looks for.
      http = __nimbusGitPack.retryingGitHttp(bundle.gitHttp);
    } catch (e) {
      return respond(false, {
        error: 'Failed to load bundled isomorphic-git: ' + (e && e.message),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, 500);
    }

    // Keep progress bounded: phase transitions/completions, plus one timed
    // update every two seconds.
    // isomorphic-git fires this callback per packfile object — thousands
    // of times for a medium repo. Each call does supervisor.stdout(...),
    // a facet→supervisor RPC that consumes input-gate time on the
    // supervisor DO and serialises behind other in-flight async work
    // (including shell keystrokes). Also emit unconditionally on phase
    // completion (loaded === total) so users still see the final frame
    // and any phase transition.
    let lastLogAt = 0;
    let lastLoggedPhase = '';
    const onProgress = async (e) => {
      if (!e || !e.phase) return;
      const now = Date.now();
      lastProgress = {
        phase: e.phase,
        loaded: Number(e.loaded) || 0,
        total: Number.isFinite(Number(e.total)) ? Number(e.total) : undefined,
      };
      const phaseChanged = e.phase !== lastLoggedPhase;
      const phaseDone = e.total && e.loaded === e.total;
      const dueByTime = now - lastLogAt >= 2000;
      if (!phaseChanged && !phaseDone && !dueByTime) return;
      lastLogAt = now;
      lastLoggedPhase = e.phase;
      log('\\r[git] ' + e.phase + ' ' + (e.loaded || 0) + '/' + (e.total || '?'));
    };
    const onAuth = () => opts.auth || { username: '', password: '' };

    let flushWave = async () => {};
    let overlayStats = emptyMetadataOverlayStats;
    let waveStats = () => undefined;
    try {
      if (typeof opts.dir !== 'string') throw new Error('git ' + opts.op + ': dir required');
      let authoritativeRoot = null;
      let authoritativeRootMetadata = null;
      let prepared = null;
      const phaseDeadline = phase === 'operation'
        ? null
        : requireMetadataNumber(opts.phaseDeadline, 'phase deadline');
      if (phase === 'clone-batch' || phase === 'clone-history' || phase === 'clone-finish') {
        if (opts.op !== 'clone') throw protocolError(phase + ' requires clone operation');
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
        if (opts.exclusiveDestination !== true) throw protocolError(phase + ' requires an exclusive destination');
        const root = normalizePath(opts.exclusiveMutationRoot || opts.dir);
        const context = gitPackContext(supervisor, stats, opts, root, phaseDeadline, log);
        mutated = true;
        if (phase === 'clone-batch') {
          await discardEarlierAttempts(context, opts, 'tmp_pack_', '_' + (opts.batch && opts.batch.index));
          const batch = await __nimbusGitPack.cloneBatch(context, {
            jobId: opts.jobId + (opts.attempt > 1 ? '_' + opts.attempt : ''),
            index: requireMetadataNumber(opts.batch && opts.batch.index, 'batch index'),
            batchBytes: requirePositiveMetadataNumber(opts.batch && opts.batch.bytes, 'batch bytes'),
            capabilities: opts.capabilities,
            partial: opts.partial === true,
            local: opts.local === true,
          });
          return respond(true, { batch, metadataOverlay: emptyMetadataOverlayStats() });
        }
        if (phase === 'clone-history') {
          const history = opts.history || {};
          let step;
          if (history.step === 'checkout-plan') {
            step = await __nimbusGitPack.clonePlanFromStore(context, {
              commit: requireOid(history.commit, 'streamed commit'),
              blobsPerBatch: opts.blobsPerBatch,
            });
          } else if (history.step === 'plan') {
            step = await __nimbusGitPack.historyPlan(context, {
              lists: history.lists,
              present: history.present,
              blobsPerBatch: opts.historyBlobsPerBatch,
            });
          } else if (history.step === 'resume') {
            step = await __nimbusGitPack.historyResume(context, { ...history, budgetUnits: opts.historyBudgetUnits });
          } else {
            await discardEarlierAttempts(context, opts, 'tmp_pack_', '_' + history.piece);
            step = await __nimbusGitPack.historyStep(context, {
              jobId: opts.jobId + (opts.attempt > 1 ? '_' + opts.attempt : ''),
              kind: history.kind,
              piece: history.piece,
              head: history.head,
              source: history.source,
              capabilities: opts.capabilities,
              budgetUnits: opts.historyBudgetUnits,
            });
          }
          return respond(true, { history: step, metadataOverlay: emptyMetadataOverlayStats() });
        }
        const finished = await __nimbusGitPack.cloneFinish(context, {
          shares: opts.shares,
          full: opts.full === true,
          cacheTreeBytes: opts.cacheTreeBytes,
          tags: opts.tags,
        });
        // The marker goes last: until it does, a failure leaves the clone abortable.
        const writer = context.writer();
        await writer.remove('.git/' + CLONE_JOB_MARKER);
        await writer.flush();
        return respond(true, { finished, metadataOverlay: emptyMetadataOverlayStats() });
      }
      if (phase === 'clone-prepare') {
        if (opts.op !== 'clone') throw protocolError('prepare requires clone operation');
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
        if (!opts.url) throw new Error('clone: url required');
        const cloneRoot = normalizePath(opts.dir);
        if (!cloneRoot) {
          throw new Error('fatal: destination path ' + JSON.stringify(opts.dir) +
            ' already exists and is not an empty directory.');
        }
        let existing = null;
        let firstMissing = null;
        const cloneRootParts = cloneRoot.split('/');
        for (let index = 0; index < cloneRootParts.length; index++) {
          const candidate = cloneRootParts.slice(0, index + 1).join('/');
          const isFinal = index === cloneRootParts.length - 1;
          stats.supervisorRpc.lstat++;
          const candidateStat = await useRpcResult(
            supervisor.lstat(candidate),
            result => result,
          );
          const isDirectory = candidateStat &&
            (candidateStat.type === 'directory' || candidateStat.type === 'dir');
          if ((!isFinal && candidateStat && !isDirectory) ||
              (isFinal && candidateStat && candidateStat.type === 'symlink')) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (!candidateStat && firstMissing === null) firstMissing = candidate;
          if (isFinal) existing = candidateStat;
        }
        const exclusiveRoot = normalizePath(opts.exclusiveMutationRoot || cloneRoot);
        if (opts.exclusiveDestination === true &&
            (exclusiveRoot !== (firstMissing || cloneRoot) ||
             (cloneRoot !== exclusiveRoot && !cloneRoot.startsWith(exclusiveRoot + '/')))) {
          throw new Error('git clone exclusive mutation root does not cover its destination');
        }
        stats.supervisorRpc.legacySymlinkSubtree++;
        const hasLegacySymlink = await useRpcResult(
          supervisor.hasLegacySymlinkUnder(exclusiveRoot),
          result => result === true,
        );
        if (hasLegacySymlink) {
          throw new Error("fatal: destination path '" + opts.dir +
            "' already exists and is not an empty directory.");
        }
        if (existing) {
          const isDirectory = existing.type === 'directory' || existing.type === 'dir';
          if (!isDirectory) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          stats.supervisorRpc.readdir++;
          const entries = await useRpcResult(supervisor.readdir(cloneRoot), result => result);
          if (!Array.isArray(entries) || entries.length !== 0) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (opts.exclusiveDestination === true) {
            authoritativeRootMetadata = metadataFromSupervisorStat(existing);
          }
        }
        if (opts.exclusiveDestination === true) authoritativeRoot = exclusiveRoot;
      } else if (phase === 'clone-abort') {
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
      } else if (opts.op === 'clone') {
        throw protocolError('clone requires its phases (prepare, batch, history, finish)');
      }

      const bufferedFs = createBufferedFs(
        supervisor,
        stats,
        authoritativeRoot,
        authoritativeRootMetadata,
        phaseDeadline,
        // fetch, pull and push work in a repository that already exists.
        phase === 'operation' ? normalizePath(opts.dir) : null,
      );
      const fs = bufferedFs.fs;
      // cf-git reads packed objects by range and stores a fetched pack as it arrives (git/pack/facet-packs.ts).
      fs.packs = __nimbusGitPack.facetPacks(facetPacksSupervisor(supervisor, stats, async (dir) => {
        // A clone's objects/pack may exist only in this fs's pending writes: publish it first.
        await fs.promises.mkdir(dir);
        await bufferedFs.flushWave();
      }));
      flushWave = bufferedFs.flushWave;
      overlayStats = bufferedFs.overlayStats;
      waveStats = bufferedFs.waveStats;

      if (phase === 'clone-prepare') {
        if (opts.filter !== undefined && opts.depth === undefined) {
          throw new Error('fatal: --filter with --no-shallow is not supported yet: clone with --depth <n>');
        }
        if (opts.exclusiveDestination !== true) throw protocolError('clone requires an exclusive destination');
        const context = gitPackContext(supervisor, stats, opts, authoritativeRoot, phaseDeadline, log);
        // Nothing is written until the server is known to serve the clone.
        const advertisement = await __nimbusGitPack.cloneDiscover(context, { filter: opts.filter });
        if (authoritativeRoot !== null && authoritativeRoot !== normalizePath(opts.dir)) {
          mutated = true;
          await fs.promises.mkdir(opts.dir);
          await flushWave();
        }
        mutated = true;
        bufferedFs.pinFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        await fs.promises.mkdir(normalizePath(opts.dir) + '/.git');
        await fs.promises.writeFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        // No Git metadata wave starts until ownership is durable. If this first
        // W7 stream loses its response, a cold abort can still prove ownership
        // from the marker; a missing or mismatched marker is never authority.
        await flushWave();
        // A full clone through the fast path starts as a depth-1 one: its
        // worktree first, its history after (clone-history). A server
        // without filter or wants by id sends its one pack (cloneStream).
        const started = await __nimbusGitPack.cloneFast(context, {
          ref: opts.ref || undefined,
          depth: opts.depth === undefined ? 1 : opts.depth,
          history: opts.depth === undefined,
          jobId: opts.jobId,
          filter: opts.filter,
          blobsPerBatch: opts.blobsPerBatch,
          budgetUnits: opts.historyBudgetUnits,
        }, advertisement);
        prepared = started.stream ? { stream: started.stream } : { fast: started };
        return respond(true, { prepared, metadataOverlay: overlayStats() });
      } else if (phase === 'clone-abort') {
        if (!await ownsCloneJob(fs, opts)) {
          return respond(true, {
            refused: 'not-owner',
            metadataOverlay: overlayStats(),
          });
        }
        mutated = true;
        // File by file, then the directories: one recursive delete of a full
        // clone's .git (vscode: ~300 packs, idx and staged files) passes a
        // write group's row limit, and the clone would stay marked.
        const gitdir = normalizePath(opts.dir) + '/.git';
        const directories = [];
        const walk = async (dir) => {
          directories.push(dir);
          for (const name of await fs.promises.readdir(dir)) {
            const path = dir + '/' + name;
            const stat = await fs.promises.lstat(path);
            if (stat.isDirectory()) await walk(path);
            else if (name !== CLONE_JOB_MARKER) await fs.promises.unlink(path);
          }
        };
        await walk(gitdir);
        await flushWave();
        for (const dir of directories.reverse()) await fs.promises.rmdir(dir, { recursive: true });
        await flushWave();
      } else if (opts.op === 'fetch-objects') {
        // A partial clone's missing objects (git/promisor.ts): one request,
        // stored as a promisor pack. Writes land below the repository only.
        const root = normalizePath(opts.dir);
        const context = gitPackContext(supervisor, stats, opts, null, null, log, root);
        const fetched = await __nimbusGitPack.fetchObjects(context, { oids: opts.oids, jobId: invocationId });
        return respond(true, { fetched, metadataOverlay: overlayStats() });
      } else if (opts.op === 'fetch') {
        // ref is the branch a pull merges; without it, the current branch's, as git fetch picks.
        await git.fetch({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref || undefined,
          depth: opts.depth,
          relative: opts.relative === true,
          singleBranch: true,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'push') {
        await git.push({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref,
          onProgress,
          onAuth,
        });
      } else {
        throw new Error('Unknown op: ' + opts.op);
      }

      if (phase === 'operation') await flushWave();

      return respond(true, { metadataOverlay: overlayStats() });
    } catch (e) {
      // Best-effort flush of partial state so user can inspect what landed
      try { await flushWave(); } catch {}
      return respond(false, {
        error: (e && e.message) || String(e),
        errorCode: e && typeof e.code === 'string' ? e.code : undefined,
        metadataOverlay: overlayStats(),
      });
    }
  },
};
`;
}
