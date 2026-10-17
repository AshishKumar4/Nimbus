/**
 * session/agent-contract.ts - Wire contract between the session agent
 * endpoints (src/session/agent.ts) and the built chat island
 * (frontend/agent-chat): types and pure functions, no runtime imports, so
 * the frontend tsconfig (DOM lib) and the worker tsconfig (workers-types)
 * can both typecheck against the same source of truth.
 */
/**
 * Append a text/reasoning delta, coalescing into the trailing part of the
 * same type so a turn stays [reasoning, text, tool, text, ...] in order.
 */
export function appendTextPart(parts, type, delta) {
    if (!delta)
        return;
    const last = parts[parts.length - 1];
    if (last?.type === type) {
        last.text += delta;
        return;
    }
    parts.push({ type, text: delta });
}
/**
 * Upsert a tool part by toolCallId. When a settle patch arrives for a part
 * whose start was observed, the duration is derived once from startedAt.
 */
export function upsertToolPart(parts, patch) {
    let part = parts.find((item) => (item.type === 'tool' && item.toolCallId === patch.toolCallId));
    if (!part) {
        part = {
            type: 'tool',
            toolCallId: patch.toolCallId,
            toolName: patch.toolName,
            status: patch.status,
        };
        parts.push(part);
    }
    const startedAt = part.startedAt;
    Object.assign(part, patch);
    if (startedAt && patch.status !== 'running' && !part.durationMs) {
        part.durationMs = Date.now() - startedAt;
    }
    return part;
}
/** Replace a stored message by id, or append it when first checkpointed. */
export function upsertStoredMessage(messages, message) {
    const index = messages.findIndex((item) => item.id === message.id);
    if (index >= 0)
        messages[index] = message;
    else
        messages.push(message);
}
/** Settle tools that cannot still be running once their turn is interrupted. */
export function interruptRunningTools(parts, reason) {
    for (const part of parts) {
        if (part.type !== 'tool' || part.status !== 'running')
            continue;
        part.status = 'error';
        part.error = reason;
        if (part.output === undefined)
            part.output = { error: reason };
    }
}
/**
 * An assistant message's parts as stored: its object-valued parts, or, for
 * an answer written before parts, its content as one text part. What each
 * reader makes of them (the model's messages, the chat's cards) is its own.
 */
export function storedMessageParts(message) {
    if (Array.isArray(message.parts)) {
        return message.parts.filter((part) => !!part && typeof part === 'object');
    }
    return message.content ? [{ type: 'text', text: message.content }] : [];
}
/**
 * A tool result written before parts, as its own `tool`-role row: the
 * tool's name (the payload's, else the row's, else 'tool'), its input, and
 * its output (the payload's, else the row's whole content).
 */
export function legacyToolResult(message) {
    let payload;
    try {
        const parsed = JSON.parse(message.content || '{}');
        payload = parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        payload = { output: message.content };
    }
    return {
        toolName: payload.tool || message.name || 'tool',
        input: payload.input,
        output: payload.output ?? message.content,
    };
}
export function isInterruptedMessage(message) {
    return message.status === 'interrupted' || message.aborted === true || typeof message.error === 'string';
}
export function textFromParts(parts) {
    return parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();
}
/**
 * The OAuth callback page's word to the chat that started the flow, sent once:
 * `postMessage` to `window.opener` when the popup still has one (it crosses
 * storage partitions, for a chat embedded in another site), else on a
 * BroadcastChannel of this name, which reaches a cross-origin isolated shell
 * whose COOP severed the popup's opener.
 */
export const AGENT_OAUTH_RESULT_CHANNEL = 'nimbus-agent-oauth';
