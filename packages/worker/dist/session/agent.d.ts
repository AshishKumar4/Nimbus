/**
 * session/agent.ts - Nimbus session chat agent and Cloudflare OAuth flow.
 *
 * The agent lives in the session Durable Object because that is where the
 * VFS, shell, process table, port registry, and runtime package manager
 * already live. AI calls go through Cloudflare's account REST API so a
 * connected user can spend their own Workers AI quota instead of the
 * Nimbus deployment owner quota.
 */
import { type ProgrammaticHost } from './programmatic.js';
interface AgentStorage {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    deleteAll(): Promise<void>;
}
interface AgentVfs {
    exists(path: string): boolean;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): void;
    readFileString(path: string): string;
    readdir(path: string): Array<{
        name: string;
        type: string;
    }>;
    writeFile(path: string, content: string): void;
}
interface Host extends ProgrammaticHost {
    ctx: {
        storage: AgentStorage;
    };
    env: ProgrammaticHost['env'] & Record<string, unknown>;
    sqliteFs: (ProgrammaticHost['sqliteFs'] & AgentVfs) | null;
}
interface OAuthStatePayload {
    v: 1;
    nonce: string;
    sessionId: string;
    tenantSegment: string;
}
export declare function handleAgentRequest(self: Host, request: Request, url: URL): Promise<Response>;
export declare function parseAgentOAuthStateParam(state: string | null): OAuthStatePayload | null;
export {};
//# sourceMappingURL=agent.d.ts.map