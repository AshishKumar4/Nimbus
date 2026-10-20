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
import { HeredocHandler, LineEditorExtender } from '@nimbus-sh/core/shell/features.js';
import { TerminalNameSchema } from '@nimbus-sh/core/workspace';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { appendScrollback, forgetScrollback, loadScrollback, writeShellSnapshot } from './state-store.js';
/** How many named terminals a session keeps, live or saved: what bounds their stored screens. */
export const NAMED_TERMINAL_LIMIT = 16;
const RESUMED_NOTICE = '[Runtime resumed; files and shell settings restored. Previous interpreter state was not retained.]\r\n';
/** A terminal's line editing: here-documents, then readline's keys over them. The session's own terminal's too. */
export function makeInteractive(shell, terminal) {
    HeredocHandler.install(shell, terminal);
    LineEditorExtender.install(shell, terminal);
}
/** A refusal of a new name past NAMED_TERMINAL_LIMIT. */
export class TerminalLimitError extends Error {
    constructor() {
        super(`a session keeps at most ${NAMED_TERMINAL_LIMIT} named terminals; close one first`);
    }
}
export class NamedTerminals {
    host;
    live = new Map();
    opening = new Map();
    /** A name's close in progress: nothing of that name opens until it has finished. */
    closing = new Map();
    /** Bumped by dispose: an opening begun before it does not publish its terminal. */
    epoch = 0;
    constructor(host) {
        this.host = host;
    }
    /** The live named terminal `pid` belongs to (its controlling terminal), if it is one's. */
    of(pid) {
        const name = this.host.workspace().processes.terminalOf(pid);
        return name === undefined || name === '' ? undefined : this.live.get(name);
    }
    /** Whether `pid` is a live named terminal's shell: it outlives every line it runs, as the session's own does. */
    isShell(pid) {
        for (const entry of this.live.values())
            if (entry.pid === pid)
                return true;
        return false;
    }
    /**
     * `ws` takes the terminal `name`, which starts if it is not live. On a
     * reconnect its stored screen is replayed; a notice it owes is said once;
     * its shell starts on the first attach (the only first prompt) and is
     * otherwise given a prompt only if its screen does not end at one
     * (Shell.resumePrompt). A wake (the same socket, after hibernation)
     * replays nothing.
     */
    async attach(name, ws, resume = 'reconnect') {
        const entry = await this.open(name);
        this.assertCurrent(entry);
        if (entry.terminal.ws === ws) {
            // Its start comes before anything it is sent.
            await entry.started;
            this.assertCurrent(entry);
            return;
        }
        entry.terminal.attach(ws);
        if (resume === 'reconnect')
            entry.terminal.replay(loadScrollback(this.host.ctx, entry.name));
        if (entry.notice) {
            entry.notice = false;
            if (entry.started === null)
                entry.terminal.write(`\r\n${RESUMED_NOTICE}`);
            else
                entry.shell.writeNotice(RESUMED_NOTICE);
        }
        if (entry.started === null) {
            entry.started = this.host.workspace().startShell(entry.shell);
            await entry.started;
        }
        else {
            await entry.started;
            this.assertCurrent(entry);
            entry.shell.resumePrompt();
        }
        this.assertCurrent(entry);
        entry.terminal.flushNow();
        ws.send(JSON.stringify({ type: 'ready' }));
    }
    /** A frame from `ws` to the terminal `name` (attached to it first, as a wake), and the line it starts, running. */
    async input(name, ws, message) {
        await this.attach(name, ws, 'wake');
        return { running: this.handle(name, message) };
    }
    /** The id of the live terminal `name`'s screen (WebSocketTerminal.id), if it is live: what a frame sent on names. */
    idOf(name) {
        return this.live.get(name)?.terminal.id;
    }
    /**
     * A frame for the live terminal `name` (only the one `id` names, when
     * given): handled until the line it starts ends or the terminal closes,
     * the shell saved now and then. One for a terminal since closed or
     * replaced is dropped.
     */
    async handle(name, message, id) {
        const entry = this.live.get(name);
        if (entry === undefined || (id !== undefined && entry.terminal.id !== id) || entry.terminal.signal.aborted)
            return;
        const terminal = entry.terminal;
        let release = () => { };
        const closed = new Promise((resolve) => { release = resolve; });
        terminal.signal.addEventListener('abort', release, { once: true });
        try {
            const completion = terminal.handleMessage(message);
            this.save(entry);
            await Promise.race([completion, closed]);
        }
        catch (error) {
            if (!terminal.signal.aborted) {
                console.error('[nimbus] terminal input failed:', errorText(error));
                terminal.writeln(`terminal input failed: ${errorText(error)}`);
            }
        }
        finally {
            terminal.signal.removeEventListener('abort', release);
            this.save(entry);
        }
    }
    /** `ws` closed: the terminal `name` is let go if `ws` had it, its shell saved; what it runs runs on. */
    detach(name, ws) {
        const entry = this.live.get(name);
        if (entry === undefined || entry.terminal.ws !== ws)
            return;
        entry.terminal.flushNow();
        this.save(entry);
        entry.terminal.detach();
    }
    /** The named terminals, live or saved, by name. */
    list() {
        const workspace = this.host.workspace();
        return [...new Set([...workspace.terminalNames(), ...this.live.keys()])].sort().map((name) => {
            const entry = this.live.get(name);
            if (entry !== undefined) {
                return { name, live: true, attached: socketOpen(entry.terminal.ws), running: entry.shell.foreground, cwd: entry.shell.getCwd() };
            }
            return { name, live: false, attached: false, running: null, cwd: workspace.terminalState(name)?.cwd ?? workspace.fs.cwd };
        });
    }
    /**
     * Close the terminal `name`: every process it controls hung up, its socket
     * closed, its stored screen, shell state and history forgotten. False when
     * there was no such terminal.
     */
    close(name) {
        const valid = TerminalNameSchema.parse(name);
        const running = this.closing.get(valid);
        if (running !== undefined)
            return running;
        const closing = this.closeNow(valid).finally(() => this.closing.delete(valid));
        this.closing.set(valid, closing);
        return closing;
    }
    async closeNow(valid) {
        await this.opening.get(valid)?.catch(() => undefined);
        const entry = this.live.get(valid);
        const known = entry !== undefined || this.host.workspace().terminalNames().includes(valid);
        if (entry !== undefined) {
            this.live.delete(valid);
            await entry.terminal.disposeRepl().catch((error) => console.warn('[terminal] REPL cleanup failed', error));
            for (const process of this.host.workspace().processes.onTerminal(valid))
                this.host.hangUp(process.pid);
            entry.terminal.close();
        }
        forgetScrollback(this.host.ctx, valid);
        await this.host.workspace().forgetTerminalShell(valid);
        return known;
    }
    /**
     * Every live terminal let go (the session closing, or destroyed): its
     * socket closed, its saved state kept; an opening still on its way is
     * abandoned.
     */
    dispose() {
        this.epoch++;
        this.opening.clear();
        for (const entry of this.live.values()) {
            entry.terminal.flushNow();
            this.save(entry);
            entry.terminal.close();
        }
        this.live.clear();
    }
    /** Whether the terminal `name` may be opened: it is live or saved, or the session holds fewer than the limit. */
    admits(name) {
        if (this.live.has(name) || this.opening.has(name))
            return true;
        const saved = this.host.workspace().terminalNames();
        return saved.includes(name) || new Set([...saved, ...this.live.keys(), ...this.opening.keys()]).size < NAMED_TERMINAL_LIMIT;
    }
    /** `epoch`: the one the request began in; a dispose since refuses it, however long it waited. */
    open(name, epoch = this.epoch) {
        const valid = TerminalNameSchema.parse(name);
        if (this.epoch !== epoch)
            return Promise.reject(new Error(`terminal ${valid}: the session's terminals were closed`));
        const live = this.live.get(valid);
        if (live !== undefined)
            return Promise.resolve(live);
        const closing = this.closing.get(valid);
        if (closing !== undefined)
            return closing.then(() => this.open(valid, epoch));
        let opening = this.opening.get(valid);
        if (opening === undefined) {
            // Counted against the limit from now (admits), not once its shell is built.
            if (!this.admits(valid))
                return Promise.reject(new TerminalLimitError());
            // One promise for every waiter: they resume in the order they asked.
            const started = this.start(valid, epoch).finally(() => {
                if (this.opening.get(valid) === started)
                    this.opening.delete(valid);
            });
            opening = started;
            this.opening.set(valid, started);
        }
        return opening;
    }
    async start(name, epoch) {
        const workspace = this.host.workspace();
        const saved = workspace.terminalNames();
        const process = workspace.processes.spawn('sh', ['sh'], workspace.fs.cwd, { parentPid: workspace.shellProcessPid, terminal: name });
        let shell;
        try {
            shell = await workspace.terminalShell(name, process.pid);
            if (this.epoch !== epoch)
                throw new Error(`terminal ${name}: the session's terminals were closed while it opened`);
        }
        catch (error) {
            // No terminal came of it: its process ends here.
            workspace.processes.exit(process.pid, 1);
            throw error;
        }
        const terminal = new WebSocketTerminal(null, (data) => {
            appendScrollback(this.host.ctx, data, Date.now(), name);
            const entry = this.live.get(name);
            if (entry !== undefined)
                this.save(entry);
        }, (send) => void workspace.processes.releaseOutput(process.pid, send));
        shell.bindTerminal(terminal);
        makeInteractive(shell, terminal);
        // The name exists from here on: listed, and counted against the limit.
        workspace.saveTerminalShell(name, shell);
        const entry = { name, pid: process.pid, shell, terminal, notice: saved.includes(name), started: null };
        this.live.set(name, entry);
        return entry;
    }
    /** A terminal closed or let go while an attach waited is not attached to (its socket is the caller's to refuse). */
    assertCurrent(entry) {
        if (this.live.get(entry.name) !== entry || entry.terminal.signal.aborted)
            throw new Error(`terminal ${entry.name} was closed`);
    }
    save(entry) {
        if (this.live.get(entry.name) !== entry)
            return;
        writeShellSnapshot(entry, entry.shell, () => this.host.workspace().saveTerminalShell(entry.name, entry.shell));
    }
}
/** Whether a terminal's socket is one a peer still has (a closed one may stay referenced until the next attach). */
export function socketOpen(ws) {
    return ws !== null && ws !== undefined && ws.readyState === WebSocket.OPEN;
}
