import { type GitFacetSupervisor } from './facet-supervisor.js';
/** The worker the git network facet exports. */
export declare const networkWorker: {
    fetch(request: Request, workerEnv: {
        SUPERVISOR?: GitFacetSupervisor;
    }): Promise<Response>;
};
//# sourceMappingURL=network-worker.d.ts.map