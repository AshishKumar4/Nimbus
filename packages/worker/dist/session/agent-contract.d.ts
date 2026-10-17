/**
 * session/agent-contract.ts - Wire contract between the session agent
 * endpoints (src/session/agent.ts) and the built chat island
 * (frontend/agent-chat): types and pure functions, no runtime imports, so
 * the frontend tsconfig (DOM lib) and the worker tsconfig (workers-types)
 * can both typecheck against the same source of truth.
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
export type StoredMessageStatus = 'streaming' | 'complete' | 'interrupted';
export interface StoredMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    createdAt: number;
    name?: string;
    parts?: StoredTurnPart[];
    /**
     * Turn lifecycle. `aborted` and `error` refine an `interrupted` status
     * with the known reason; an orphaned reset has neither reason marker.
     * Missing status is valid for history written before lifecycle tracking.
     */
    status?: StoredMessageStatus;
    /**
     * On an answer, the id of the user message it answers: turns may run at
     * once, so an answer need not follow its question. Missing on answers
     * written before answers named it.
     */
    replyTo?: string;
    /** Present only when an interrupted turn was stopped by the client. */
    aborted?: true;
    /** Present only when an interrupted turn ended in a provider/stream error. */
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
export type StoredToolPartPatch = Omit<StoredToolPart, 'type'>;
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
/** Replace a stored message by id, or append it when first checkpointed. */
export declare function upsertStoredMessage(messages: StoredMessage[], message: StoredMessage): void;
/** Settle tools that cannot still be running once their turn is interrupted. */
export declare function interruptRunningTools(parts: StoredTurnPart[], reason: string): void;
/**
 * An assistant message's parts as stored: its object-valued parts, or, for
 * an answer written before parts, its content as one text part. What each
 * reader makes of them (the model's messages, the chat's cards) is its own.
 */
export declare function storedMessageParts(message: StoredMessage): StoredTurnPart[];
/**
 * A tool result written before parts, as its own `tool`-role row: the
 * tool's name (the payload's, else the row's, else 'tool'), its input, and
 * its output (the payload's, else the row's whole content).
 */
export declare function legacyToolResult(message: StoredMessage): Pick<StoredToolPart, 'toolName' | 'input' | 'output'>;
export declare function isInterruptedMessage(message: StoredMessage): boolean;
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
/**
 * The OAuth callback page's word to the chat that started the flow, sent once:
 * `postMessage` to `window.opener` when the popup still has one (it crosses
 * storage partitions, for a chat embedded in another site), else on a
 * BroadcastChannel of this name, which reaches a cross-origin isolated shell
 * whose COOP severed the popup's opener.
 */
export declare const AGENT_OAUTH_RESULT_CHANNEL = "nimbus-agent-oauth";
export interface AgentOAuthResultMessage {
    type: typeof AGENT_OAUTH_RESULT_CHANNEL;
    ok: boolean;
}
//# sourceMappingURL=agent-contract.d.ts.map