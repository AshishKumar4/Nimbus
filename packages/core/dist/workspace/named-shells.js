/**
 * named-shells.ts — a workspace's named shells.
 *
 * A named shell is a cwd and an environment that outlive the call that set
 * them, the way a terminal tab's do. Each name is a row of the workspace's
 * `vfs_shells` table, so it outlives the workspace object and its host's
 * restarts. Calls on one name run one at a time, in the order they were
 * made: two at once would read one state and race to write it back, and the
 * loser's `cd` would vanish. Calls on different names run at once.
 *
 * A call's functions, aliases, options, umask and descriptors are its
 * process's and end with it; only cwd and environment persist. The shell a
 * call runs in is built by the workspace for the call's own process
 * (`NimbusWorkspace.shellFor`), from the state this module keeps.
 */
import { z } from 'zod/v4';
import { cloneEnv } from '../substrate/lifo/shell/variables.js';
/** A shell's name, the rule an `execId` follows. */
const ShellIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ShellStateSchema = z.object({
    cwd: z.string().startsWith('/'),
    env: z.custom((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return false;
        const prototype = Object.getPrototypeOf(value);
        return (prototype === null || prototype === Object.prototype) && Object.values(value).every((entry) => typeof entry === 'string');
    }).transform(cloneEnv),
}).strict();
/** A saved shell state, or an error naming what is wrong with it. */
export function parseShellState(value) {
    return ShellStateSchema.parse(value);
}
/** Where named shells are saved, one row each; made by the first call that names one. */
export const SHELLS_TABLE = 'vfs_shells';
export class NamedShells {
    sql;
    home;
    shellFor;
    /** One queue per name: the last call made on it, settled when that call is. */
    queues = new Map();
    idle = Promise.resolve();
    parsedName;
    constructor(sql, 
    /** Where a name with no saved state and no `start` begins. */
    home, 
    /** The shell for one call's process, in `state`. */
    shellFor) {
        this.sql = sql;
        this.home = home;
        this.shellFor = shellFor;
    }
    /**
     * Run `body` in the named shell `id`: in the cwd and environment the last
     * call on that name left it with, else `options.start`, and save what the
     * shell holds when `body` settles. A name's first call saves where it
     * started even when it saves nothing else (`persist: false`), so the name
     * exists from then on, rooted there.
     */
    hold(id, options, body) {
        return this.run(id, options, body);
    }
    /** The last saved state, after earlier calls on this name have settled. */
    read(id) {
        return this.run(id);
    }
    async run(id, options, body) {
        // Cache only name syntax; reload its saved state on every turn.
        const name = this.parsedName !== undefined && id === this.parsedName ? id : ShellIdSchema.parse(id);
        this.parsedName = name;
        const queued = this.queues.get(name);
        const previous = queued ?? this.idle;
        let release = () => { };
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = queued === undefined ? gate : previous.then(() => gate);
        this.queues.set(name, tail);
        await previous;
        let detached = false;
        const leave = () => {
            release();
            if (this.queues.get(name) === tail)
                this.queues.delete(name);
        };
        const detach = () => { detached = true; leave(); };
        try {
            // Every call, so a workspace whose tables were dropped makes it again.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS ${SHELLS_TABLE} (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT NOT NULL)`);
            const [row] = this.sql.exec(`SELECT cwd, env FROM ${SHELLS_TABLE} WHERE id = ?`, name);
            const saved = row === undefined ? null : parseShellState({ cwd: row.cwd, env: JSON.parse(String(row.env)) });
            if (options === undefined || body === undefined)
                return saved;
            const state = saved ?? { cwd: options.start?.cwd ?? this.home, env: options.start?.env ?? {} };
            // The next owner may start before this body settles. It sees the last
            // durable state, including a new name's initial root, never this body's
            // in-flight cwd/environment or its later completion.
            if (saved === null)
                this.save(name, state);
            if (options.detach?.aborted)
                detach();
            else
                options.detach?.addEventListener('abort', detach, { once: true });
            const call = {};
            try {
                return await body({ cwd: state.cwd, open: (pid) => (call.shell = this.shellFor(pid, state)) });
            }
            finally {
                if (!detached && options.persist !== false)
                    this.save(name, call.shell ? { cwd: call.shell.getCwd(), env: call.shell.getEnv() } : state);
            }
        }
        finally {
            options?.detach?.removeEventListener('abort', detach);
            leave();
        }
    }
    save(name, state) {
        const env = cloneEnv(state.env);
        // `$` is the pid of the call that just ended, not state of the shell.
        delete env.$;
        this.sql.exec(`INSERT INTO ${SHELLS_TABLE} (id, cwd, env) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, env = excluded.env`, name, state.cwd, JSON.stringify(env));
    }
}
