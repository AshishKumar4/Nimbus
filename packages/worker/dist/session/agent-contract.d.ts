/**
 * session/agent-contract.ts - Wire contract between the session agent
 * endpoints (src/session/agent.ts) and the built chat island
 * (frontend/agent-chat). Pure types, no runtime imports, so the frontend
 * tsconfig (DOM lib) and the worker tsconfig (workers-types) can both
 * typecheck against the same source of truth.
 */
export type StoredTurnPart = {
    type: 'text';
    text: string;
} | {
    type: 'reasoning';
    text: string;
} | {
    type: 'tool';
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    status: 'running' | 'done' | 'error';
    startedAt?: number;
    durationMs?: number;
};
export type StoredToolPart = Extract<StoredTurnPart, {
    type: 'tool';
}>;
export interface StoredMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    createdAt: number;
    name?: string;
    parts?: StoredTurnPart[];
    /** Present when the turn was stopped by the client before it finished. */
    aborted?: true;
    /** Present when the turn ended in a terminal provider/stream error. */
    error?: string;
}
/** Per-step token usage as reported by the model provider. */
export interface AgentTurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}
export type AgentStreamEvent = {
    type: 'start';
    messages: StoredMessage[];
} | {
    type: 'message';
    message: StoredMessage;
} | {
    type: 'assistant-start';
    messageId: string;
    createdAt: number;
} | {
    type: 'text-delta';
    delta: string;
} | {
    type: 'reasoning-delta';
    delta: string;
} | {
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    input: unknown;
} | {
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    input: unknown;
    output: unknown;
    status: 'done' | 'error';
} | {
    type: 'tool-error';
    toolCallId: string;
    toolName: string;
    input: unknown;
    error: string;
} | {
    type: 'finish-step';
    finishReason?: string;
    usage?: AgentTurnUsage;
} | {
    type: 'done';
    message: StoredMessage;
    messages: StoredMessage[];
} | {
    type: 'error';
    error: string;
    code: string;
    messages: StoredMessage[];
};
export type StoredToolPartPatch = Omit<StoredToolPart, 'type' | 'status'> & {
    status?: StoredToolPart['status'];
};
/**
 * Append a text/reasoning delta, coalescing into the trailing part of the
 * same type so a turn stays [reasoning, text, tool, text, ...] in order.
 */
export declare function appendTextPart(parts: StoredTurnPart[], type: 'text' | 'reasoning', delta: string): void;
/**
 * Upsert a tool part by toolCallId. When a settle patch arrives for a part
 * whose start was observed, the duration is derived once from startedAt.
 */
export declare function upsertToolPart(parts: StoredTurnPart[], patch: StoredToolPartPatch): StoredToolPart;
export declare function textFromParts(parts: StoredTurnPart[]): string;
export interface AgentAccount {
    id: string;
    name?: string;
}
/** GET /api/agent/status response body. */
export interface AgentStatusPayload {
    ok: boolean;
    configured: boolean;
    model: string;
    gatewayId: string;
    oauth: {
        configured: boolean;
        connected: boolean;
        clientId: string | null;
        scopes: string[];
        user: unknown;
        accounts: AgentAccount[];
        accountId: string | null;
        expiresAt: number | null;
    };
    ownerToken: {
        configured: boolean;
        accountId: string | null;
        disabledByUserOAuthRequired: boolean;
    };
    connected: boolean;
    capabilities: string[];
}
//# sourceMappingURL=agent-contract.d.ts.map