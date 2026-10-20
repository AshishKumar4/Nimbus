/**
 * named-terminals.ts — a session's terminals by name (`/ws?terminal=<name>`),
 * beside its own one, which stays as it is.
 *
 * A named terminal is a shell of its own (a process `sh` whose controlling
 * terminal is the name, so everything started from it is the terminal's),
 * its line editing, and its screen. Its shell is a named shell: its cwd,
 * variables and history file are saved as it changes and outlive the
 * session's restarts; its screen is stored as the session's own terminal's
 * is, capped on its own. A socket closing detaches it: what it runs runs on.
 * A close hangs everything on it up and forgets it.
 */
import type { Shell } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { type NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { SessionTerminal } from '@nimbus-sh/core/runtime/session-protocol.js';
/** How many named terminals a session keeps, live or saved: what bounds their stored screens. */
export declare const NAMED_TERMINAL_LIMIT = 16;
/** A terminal's line editing: here-documents, then readline's keys over them. The session's own terminal's too. */
export declare function makeInteractive(shell: Shell, terminal: WebSocketTerminal): void;
/** What a terminal's socket sends it (WebSocketTerminal.handleMessage): typing, its size. */
export type TerminalMessage = Parameters<WebSocketTerminal['handleMessage']>[0];
/** A refusal of a new name past NAMED_TERMINAL_LIMIT. */
export declare class TerminalLimitError extends Error {
    constructor();
}
export interface NamedTerminalsHost {
    /** Where the screens are stored (`ctx.storage.sql`). */
    readonly ctx: DurableObjectState;
    /** The session's workspace (built before any terminal is). */
    workspace(): NimbusWorkspace;
    /** Ends `pid` as a hang-up (HUP) does, by the host's own kill. */
    hangUp(pid: number): void;
}
export declare class NamedTerminals {
    private readonly host;
    private readonly live;
    private readonly opening;
    /** A name's close in progress: nothing of that name opens until it has finished. */
    private readonly closing;
    /** Bumped by dispose: an opening begun before it does not publish its terminal. */
    private epoch;
    constructor(host: NamedTerminalsHost);
    /** The live named terminal `pid` belongs to (its controlling terminal), if it is one's. */
    of(pid: number): {
        readonly shell: Shell;
        readonly terminal: WebSocketTerminal;
    } | undefined;
    /** Whether `pid` is a live named terminal's shell: it outlives every line it runs, as the session's own does. */
    isShell(pid: number): boolean;
    /**
     * `ws` takes the terminal `name`, which starts if it is not live. On a
     * reconnect its stored screen is replayed; a notice it owes is said once;
     * its shell starts on the first attach (the only first prompt) and is
     * otherwise given a prompt only if its screen does not end at one
     * (Shell.resumePrompt). A wake (the same socket, after hibernation)
     * replays nothing.
     */
    attach(name: string, ws: WebSocket, resume?: 'reconnect' | 'wake'): Promise<void>;
    /** A frame from `ws` to the terminal `name` (attached to it first, as a wake), and the line it starts, running. */
    input(name: string, ws: WebSocket, message: TerminalMessage): Promise<{
        readonly running: Promise<void>;
    }>;
    /** The id of the live terminal `name`'s screen (WebSocketTerminal.id), if it is live: what a frame sent on names. */
    idOf(name: string): string | undefined;
    /**
     * A frame for the live terminal `name` (only the one `id` names, when
     * given): handled until the line it starts ends or the terminal closes,
     * the shell saved now and then. One for a terminal since closed or
     * replaced is dropped.
     */
    handle(name: string, message: TerminalMessage, id?: string): Promise<void>;
    /** `ws` closed: the terminal `name` is let go if `ws` had it, its shell saved; what it runs runs on. */
    detach(name: string, ws: WebSocket): void;
    /** The named terminals, live or saved, by name. */
    list(): SessionTerminal[];
    /**
     * Close the terminal `name`: every process it controls hung up, its socket
     * closed, its stored screen, shell state and history forgotten. False when
     * there was no such terminal.
     */
    close(name: string): Promise<boolean>;
    private closeNow;
    /**
     * Every live terminal let go (the session closing, or destroyed): its
     * socket closed, its saved state kept; an opening still on its way is
     * abandoned.
     */
    dispose(): void;
    /** Whether the terminal `name` may be opened: it is live or saved, or the session holds fewer than the limit. */
    admits(name: string): boolean;
    private open;
    private start;
    private save;
}
/** Whether a terminal's socket is one a peer still has (a closed one may stay referenced until the next attach). */
export declare function socketOpen(ws: WebSocket | null | undefined): boolean;
//# sourceMappingURL=named-terminals.d.ts.map