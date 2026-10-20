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
import { HeredocHandler, LineEditorExtender } from '@nimbus-sh/core/shell/features.js';
import { TerminalNameSchema, type NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import type { SessionTerminal } from '@nimbus-sh/core/runtime/session-protocol.js';
import { appendScrollback, forgetScrollback, loadScrollback, writeShellSnapshot } from './state-store.js';

/** How many named terminals a session keeps, live or saved: what bounds their stored screens. */
export const NAMED_TERMINAL_LIMIT = 16;

const RESUMED_NOTICE = '[Runtime resumed; files and shell settings restored. Previous interpreter state was not retained.]\r\n';

/** A terminal's line editing: here-documents, then readline's keys over them. The session's own terminal's too. */
export function makeInteractive(shell: Shell, terminal: WebSocketTerminal): void {
  HeredocHandler.install(shell, terminal);
  LineEditorExtender.install(shell, terminal);
}

/** What a terminal's socket sends it (WebSocketTerminal.handleMessage): typing, its size. */
export type TerminalMessage = Parameters<WebSocketTerminal['handleMessage']>[0];


/** A refusal of a new name past NAMED_TERMINAL_LIMIT. */
export class TerminalLimitError extends Error {
  constructor() {
    super(`a session keeps at most ${NAMED_TERMINAL_LIMIT} named terminals; close one first`);
  }
}

interface NamedTerminal {
  readonly name: string;
  readonly pid: number;
  readonly shell: Shell;
  readonly terminal: WebSocketTerminal;
  /** The resumed notice is owed: the name had a shell in an earlier incarnation. */
  notice: boolean;
  /** Its shell's start (login files, first prompt), once the first socket attaches. */
  started: Promise<void> | null;
}

export interface NamedTerminalsHost {
  /** Where the screens are stored (`ctx.storage.sql`). */
  readonly ctx: DurableObjectState;
  /** The session's workspace (built before any terminal is). */
  workspace(): NimbusWorkspace;
  /** Ends `pid` as a hang-up (HUP) does, by the host's own kill. */
  hangUp(pid: number): void;
}

export class NamedTerminals {
  private readonly live = new Map<string, NamedTerminal>();
  private readonly opening = new Map<string, Promise<NamedTerminal>>();
  /** A name's close in progress: nothing of that name opens until it has finished. */
  private readonly closing = new Map<string, Promise<boolean>>();
  /** Bumped by dispose: an opening begun before it does not publish its terminal. */
  private epoch = 0;

  constructor(private readonly host: NamedTerminalsHost) {}

  /** The live named terminal `pid` belongs to (its controlling terminal), if it is one's. */
  of(pid: number): { readonly shell: Shell; readonly terminal: WebSocketTerminal } | undefined {
    const name = this.host.workspace().processes.terminalOf(pid);
    return name === undefined || name === '' ? undefined : this.live.get(name);
  }

  /** Whether `pid` is a live named terminal's shell: it outlives every line it runs, as the session's own does. */
  isShell(pid: number): boolean {
    for (const entry of this.live.values()) if (entry.pid === pid) return true;
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
  async attach(name: string, ws: WebSocket, resume: 'reconnect' | 'wake' = 'reconnect'): Promise<void> {
    const entry = await this.open(name);
    this.assertCurrent(entry);
    if (entry.terminal.ws === ws) {
      // Its start comes before anything it is sent.
      await entry.started;
      this.assertCurrent(entry);
      return;
    }
    entry.terminal.attach(ws);
    if (resume === 'reconnect') entry.terminal.replay(loadScrollback(this.host.ctx, entry.name));
    if (entry.notice) {
      entry.notice = false;
      if (entry.started === null) entry.terminal.write(`\r\n${RESUMED_NOTICE}`);
      else entry.shell.writeNotice(RESUMED_NOTICE);
    }
    if (entry.started === null) {
      entry.started = this.host.workspace().startShell(entry.shell);
      await entry.started;
    } else {
      await entry.started;
      this.assertCurrent(entry);
      entry.shell.resumePrompt();
    }
    this.assertCurrent(entry);
    entry.terminal.flushNow();
    ws.send(JSON.stringify({ type: 'ready' }));
  }

  /** A frame from `ws` to the terminal `name` (attached to it first, as a wake), and the line it starts, running. */
  async input(name: string, ws: WebSocket, message: TerminalMessage): Promise<{ readonly running: Promise<void> }> {
    await this.attach(name, ws, 'wake');
    return { running: this.handle(name, message) };
  }

  /** The id of the live terminal `name`'s screen (WebSocketTerminal.id), if it is live: what a frame sent on names. */
  idOf(name: string): string | undefined {
    return this.live.get(name)?.terminal.id;
  }

  /**
   * A frame for the live terminal `name` (only the one `id` names, when
   * given): handled until the line it starts ends or the terminal closes,
   * the shell saved now and then. One for a terminal since closed or
   * replaced is dropped.
   */
  async handle(name: string, message: TerminalMessage, id?: string): Promise<void> {
    const entry = this.live.get(name);
    if (entry === undefined || (id !== undefined && entry.terminal.id !== id) || entry.terminal.signal.aborted) return;
    const terminal = entry.terminal;
    let release = () => {};
    const closed = new Promise<void>((resolve) => { release = resolve; });
    terminal.signal.addEventListener('abort', release, { once: true });
    try {
      const completion = terminal.handleMessage(message);
      this.save(entry);
      await Promise.race([completion, closed]);
    } catch (error) {
      if (!terminal.signal.aborted) {
        console.error('[nimbus] terminal input failed:', errorText(error));
        terminal.writeln(`terminal input failed: ${errorText(error)}`);
      }
    } finally {
      terminal.signal.removeEventListener('abort', release);
      this.save(entry);
    }
  }

  /** `ws` closed: the terminal `name` is let go if `ws` had it, its shell saved; what it runs runs on. */
  detach(name: string, ws: WebSocket): void {
    const entry = this.live.get(name);
    if (entry === undefined || entry.terminal.ws !== ws) return;
    entry.terminal.flushNow();
    this.save(entry);
    entry.terminal.detach();
  }

  /** The named terminals, live or saved, by name. */
  list(): SessionTerminal[] {
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
  close(name: string): Promise<boolean> {
    const valid = TerminalNameSchema.parse(name);
    const running = this.closing.get(valid);
    if (running !== undefined) return running;
    const closing = this.closeNow(valid).finally(() => this.closing.delete(valid));
    this.closing.set(valid, closing);
    return closing;
  }

  private async closeNow(valid: string): Promise<boolean> {
    await this.opening.get(valid)?.catch(() => undefined);
    const entry = this.live.get(valid);
    const known = entry !== undefined || this.host.workspace().terminalNames().includes(valid);
    if (entry !== undefined) {
      this.live.delete(valid);
      await entry.terminal.disposeRepl().catch((error: unknown) => console.warn('[terminal] REPL cleanup failed', error));
      for (const process of this.host.workspace().processes.onTerminal(valid)) this.host.hangUp(process.pid);
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
  dispose(): void {
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
  admits(name: string): boolean {
    if (this.live.has(name) || this.opening.has(name)) return true;
    const saved = this.host.workspace().terminalNames();
    return saved.includes(name) || new Set([...saved, ...this.live.keys(), ...this.opening.keys()]).size < NAMED_TERMINAL_LIMIT;
  }

  private open(name: string): Promise<NamedTerminal> {
    const valid = TerminalNameSchema.parse(name);
    const live = this.live.get(valid);
    if (live !== undefined) return Promise.resolve(live);
    const closing = this.closing.get(valid);
    if (closing !== undefined) return closing.then(() => this.open(valid));
    let opening = this.opening.get(valid);
    if (opening === undefined) {
      // Counted against the limit from now (admits), not once its shell is built.
      if (!this.admits(valid)) return Promise.reject(new TerminalLimitError());
      // One promise for every waiter: they resume in the order they asked.
      const started: Promise<NamedTerminal> = this.start(valid).finally(() => {
        if (this.opening.get(valid) === started) this.opening.delete(valid);
      });
      opening = started;
      this.opening.set(valid, started);
    }
    return opening;
  }

  private async start(name: string): Promise<NamedTerminal> {
    const workspace = this.host.workspace();
    const epoch = this.epoch;
    const saved = workspace.terminalNames();
    const process = workspace.processes.spawn('sh', ['sh'], workspace.fs.cwd, { parentPid: workspace.shellProcessPid, terminal: name });
    let shell: Shell;
    try {
      shell = await workspace.terminalShell(name, process.pid);
      if (this.epoch !== epoch) throw new Error(`terminal ${name}: the session's terminals were closed while it opened`);
    } catch (error) {
      // No terminal came of it: its process ends here.
      workspace.processes.exit(process.pid, 1);
      throw error;
    }
    const terminal = new WebSocketTerminal(null, (data) => {
      appendScrollback(this.host.ctx, data, Date.now(), name);
      const entry = this.live.get(name);
      if (entry !== undefined) this.save(entry);
    }, (send) => void workspace.processes.releaseOutput(process.pid, send));
    shell.bindTerminal(terminal);
    makeInteractive(shell, terminal);
    // The name exists from here on: listed, and counted against the limit.
    workspace.saveTerminalShell(name, shell);
    const entry: NamedTerminal = { name, pid: process.pid, shell, terminal, notice: saved.includes(name), started: null };
    this.live.set(name, entry);
    return entry;
  }

  /** A terminal closed or let go while an attach waited is not attached to (its socket is the caller's to refuse). */
  private assertCurrent(entry: NamedTerminal): void {
    if (this.live.get(entry.name) !== entry || entry.terminal.signal.aborted) throw new Error(`terminal ${entry.name} was closed`);
  }

  private save(entry: NamedTerminal): void {
    if (this.live.get(entry.name) !== entry) return;
    writeShellSnapshot(entry, entry.shell, () => this.host.workspace().saveTerminalShell(entry.name, entry.shell));
  }
}

/** Whether a terminal's socket is one a peer still has (a closed one may stay referenced until the next attach). */
export function socketOpen(ws: WebSocket | null | undefined): boolean {
  return ws !== null && ws !== undefined && ws.readyState === WebSocket.OPEN;
}
