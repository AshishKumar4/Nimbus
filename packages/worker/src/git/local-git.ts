import type { CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { FacetProcessManager } from '../facets/process.js';
import type { LocalGit } from './remote-helper.js';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const encoder = new TextEncoder();

/** Git's object and ref operations, as children of the remote helper on the session's byte pipes. */
export function createLocalGit(manager: FacetProcessManager, from: Pick<CommandContext, 'pid' | 'cwd' | 'env' | 'signal'>): LocalGit {
  const run = (gitDir: string, args: string[], input: () => Promise<string>): ReadableStream<Uint8Array> => {
    let pid: number | null = null;
    let ended = false;
    let cursor = 0;
    const cancelled = () => new DOMException('git child cancelled', 'AbortError');
    const close = () => {
      from.signal.removeEventListener('abort', abort);
      if (pid !== null) {
        manager.closeOutput(pid, 1);
        manager.closeOutput(pid, 2);
      }
    };
    const kill = () => { if (pid !== null) manager.kill(pid, 'SIGTERM'); close(); };
    let abort = () => {};
    let opened: Promise<{ pid: number; complete: Promise<void> }>;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          if (ended) return;
          ended = true;
          kill();
          controller.error(cancelled());
        };
        from.signal.addEventListener('abort', abort, { once: true });
        opened = (async () => {
          if (from.signal.aborted) throw cancelled();
          const text = await input();
          if (ended || from.signal.aborted) throw cancelled();
          const child = await manager.spawn({
            command: 'git', args, parentPid: from.pid, cwd: from.cwd,
            env: { ...from.env, GIT_DIR: gitDir, NIMBUS_GIT_WASI: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          pid = child.childPid;
          if (ended || from.signal.aborted) { kill(); throw cancelled(); }
          let detail = '';
          const stderr = (async () => {
            const decoder = new TextDecoder();
            let since = 0;
            for (;;) {
              const result = await manager.readOutput(child.childPid, 2, since);
              for (const chunk of result.chunks) detail = (detail + decoder.decode(chunk.data, { stream: true })).slice(-64 * 1024);
              since = result.maxSeq;
              if (result.closed) break;
            }
            detail += decoder.decode();
          })();
          const feed = (async () => {
            const bytes = encoder.encode(text);
            for (let at = 0; at < bytes.byteLength; at += 65536) {
              const wrote = await manager.stdinWrite(child.childPid, bytes.subarray(at, at + 65536));
              if (!wrote.ok) throw new Error('git child closed stdin');
            }
            await manager.stdinEnd(child.childPid);
          })();
          const wait = (async () => {
            for (;;) {
              const status = await manager.wait(child.childPid);
              if (status.done) return status;
            }
          })();
          const complete = Promise.all([feed, stderr, wait]).then(([, , status]) => {
            if (from.signal.aborted) throw cancelled();
            if (status.exitCode !== 0 || status.signal !== null) {
              throw new Error(`git ${args[0]} exited ${status.exitCode ?? status.signal}${detail.trim() ? ': ' + detail.trim() : ''}`);
            }
          });
          complete.catch((error) => {
            if (ended) return;
            ended = true;
            kill();
            controller.error(error);
          });
          return { pid: child.childPid, complete };
        })();
        opened.catch((error) => {
          if (ended) return;
          ended = true;
          kill();
          controller.error(error);
        });
      },
      async pull(controller) {
        try {
          const child = await opened;
          while (!ended) {
            const result = await manager.readOutput(child.pid, 1, cursor);
            if (ended) return;
            cursor = result.maxSeq;
            for (const chunk of result.chunks) controller.enqueue(chunk.data);
            if (result.closed) {
              await child.complete;
              if (ended) return;
              ended = true;
              close();
              controller.close();
            }
            if (result.closed || result.chunks.length > 0) return;
          }
        } catch (error) {
          if (ended) return;
          ended = true;
          kill();
          controller.error(error);
        }
      },
      async cancel() {
        ended = true;
        kill();
        const child = await opened.catch(() => null);
        if (child) { kill(); await child.complete.catch(() => {}); }
      },
    });
  };
  const check = async (gitDir: string, refs: string[]): Promise<Array<string | null>> => {
    if (refs.length === 0) return [];
    const text = await new Response(run(gitDir, ['cat-file', '--batch-check=%(objectname)'], async () => refs.join('\n') + '\n')).text();
    const lines = text.trimEnd().split('\n');
    return refs.map((_, i) => OID.test(lines[i] ?? '') ? lines[i] : null);
  };
  const has = async (gitDir: string, oids: string[]): Promise<Set<string>> => {
    const checked = await check(gitDir, oids);
    return new Set(oids.filter((_, i) => checked[i] !== null));
  };
  return {
    has,
    async resolve(gitDir, ref) { return (await check(gitDir, [ref]))[0] ?? null; },
    packObjects({ gitDir, include, exclude }) {
      return run(gitDir, ['pack-objects', '--revs', '--thin', '--stdout', '-q'], async () => {
        const present = await has(gitDir, exclude);
        return [...include, ...exclude.filter((oid) => present.has(oid)).map((oid) => '^' + oid)].join('\n') + '\n';
      });
    },
  };
}
