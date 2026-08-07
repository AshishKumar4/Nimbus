import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import { formatShellPrompt } from '../substrate/lifo/shell/Shell.js';
import type { VfsCred } from './os-contracts.js';
import type { RuntimeManifest } from './runtime-catalog.js';
import { createBashFacetSession, type BashFacetSession } from './bash-runner.js';
import type { BashSlice } from './bash/types.js';
import {
  ReplSession,
  type ReplAdapter,
  type ReplPushResult,
} from './repl-session.js';

export interface BashReplDeps {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
  terminal: WebSocketTerminal;
  installRoot: string;
  manifest: RuntimeManifest;
  cred: VfsCred;
  env: Record<string, string>;
  cwd: string;
  shell?: Pick<Shell, 'env' | 'cwd'>;
}

class BashReplAdapter implements ReplAdapter {
  private readonly ps1Sentinel = `__NIMBUS_BASH_PS1_${crypto.randomUUID()}__`;
  private readonly ps2Sentinel = `__NIMBUS_BASH_PS2_${crypto.randomUUID()}__`;
  private session: BashFacetSession | null = null;
  private incompleteSource: string | null = null;
  private pendingStdout = '';
  private pendingStderr = '';

  readonly ps2 = '> ';

  constructor(private readonly deps: BashReplDeps) {}

  get ps1(): string {
    const env = this.deps.shell?.env ?? this.deps.env;
    const cwd = this.deps.shell?.cwd ?? this.deps.cwd;
    return formatShellPrompt(env, cwd);
  }

  banner(): string {
    return '';
  }

  async push(source: string): Promise<ReplPushResult> {
    try {
      const bootResult = await this.ensureSession();
      if (bootResult) return bootResult;

      const delta = this.sourceDelta(source);
      const slice = await this.session!.push(`${delta}\n`);
      return this.consumeSlice(slice, source);
    } catch (error: unknown) {
      return {
        kind: 'error',
        stderr: `bash: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.incompleteSource = null;
    this.pendingStdout = '';
    this.pendingStderr = '';
    await session?.close();
  }

  private async ensureSession(): Promise<ReplPushResult | null> {
    if (this.session) return null;
    this.session = await createBashFacetSession({
      facetMgr: this.deps.facetMgr,
      vfs: this.deps.vfs.as(this.deps.cred),
      manifest: this.deps.manifest,
      installRoot: this.deps.installRoot,
      argv: ['bash', '--noediting', '-i'],
      env: {
        ...this.deps.env,
        PS1: this.ps1Sentinel,
        PS2: this.ps2Sentinel,
        TERM: 'dumb',
      },
      cwd: this.deps.cwd,
      stdinClosed: false,
      stdinTty: true,
    });

    const initial = this.session.initial;
    if (initial.state !== 'need-input') return this.consumeSlice(initial, '');
    const prompt = this.takePrompt(initial.stderr);
    this.pendingStdout += initial.stdout;
    this.pendingStderr += prompt.stderr;
    if (prompt.kind === 'ps1') return null;
    return {
      kind: 'exit',
      exitCode: 1,
      ...this.takeOutput(`bash: interactive boot did not reach PS1\n`),
    };
  }

  private sourceDelta(source: string): string {
    if (this.incompleteSource === null) return source;
    const prior = `${this.incompleteSource}\n`;
    return source.startsWith(prior) ? source.slice(prior.length) : source;
  }

  private consumeSlice(slice: BashSlice, source: string): ReplPushResult {
    const prompt = this.takePrompt(slice.stderr);
    this.pendingStdout += slice.stdout;
    this.pendingStderr += prompt.stderr;

    if (slice.state === 'exited') {
      this.incompleteSource = null;
      return {
        kind: 'exit',
        exitCode: slice.exitCode,
        ...this.takeOutput(),
      };
    }
    if (slice.state === 'error') {
      this.incompleteSource = null;
      return {
        kind: 'exit',
        exitCode: slice.exitCode || 1,
        ...this.takeOutput(`bash: ${slice.error || 'facet error'}\n`),
      };
    }
    if (prompt.kind === 'ps2') {
      this.incompleteSource = source;
      return { kind: 'incomplete' };
    }
    if (prompt.kind === 'ps1') {
      this.incompleteSource = null;
      return { kind: 'output', ...this.takeOutput() };
    }
    return {
      kind: 'exit',
      exitCode: 1,
      ...this.takeOutput('bash: interactive command did not reach a prompt\n'),
    };
  }

  private takePrompt(stderr: string): {
    kind: 'ps1' | 'ps2' | null;
    stderr: string;
  } {
    if (stderr.endsWith(this.ps1Sentinel)) {
      return {
        kind: 'ps1',
        stderr: stderr.slice(0, -this.ps1Sentinel.length),
      };
    }
    if (stderr.endsWith(this.ps2Sentinel)) {
      return {
        kind: 'ps2',
        stderr: stderr.slice(0, -this.ps2Sentinel.length),
      };
    }
    return { kind: null, stderr };
  }

  private takeOutput(extraStderr = ''): {
    stdout: string;
    stderr: string;
  } {
    const output = {
      stdout: this.pendingStdout,
      stderr: this.pendingStderr + extraStderr,
    };
    this.pendingStdout = '';
    this.pendingStderr = '';
    return output;
  }
}

export async function runBashRepl(deps: BashReplDeps): Promise<number> {
  const session = new ReplSession(new BashReplAdapter(deps), deps.terminal, deps.shell);
  return await session.run();
}
