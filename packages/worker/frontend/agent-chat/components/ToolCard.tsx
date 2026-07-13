import { useEffect, useRef, useState } from 'preact/hooks';
import type { StoredToolPart } from '../../../src/session/agent-contract.js';

/** Duration below which we do not show a timer (it reads as noise). */
const MIN_SHOWN_MS = 100;

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function commandOf(part: StoredToolPart): string | null {
  if (part.toolName !== 'exec' && part.toolName !== 'start_process') return null;
  const input = part.input;
  if (!input || typeof input !== 'object') return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() ? command.trim() : null;
}

/**
 * Elapsed timer that only counts runs we actually observed start (live
 * streaming), never guessing durations for history loaded mid-flight.
 */
function useObservedElapsed(running: boolean): number | null {
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (running) {
      startedAt.current = Date.now();
      setElapsed(0);
      const timer = setInterval(() => {
        if (startedAt.current != null) setElapsed(Date.now() - startedAt.current);
      }, 100);
      return () => clearInterval(timer);
    }
    if (startedAt.current != null) {
      setElapsed(Date.now() - startedAt.current);
      startedAt.current = null;
    }
    return undefined;
  }, [running]);
  return elapsed;
}

export function ToolCard({ part }: { part: StoredToolPart }) {
  // Auto-open while running; once settled it returns to (or stays at)
  // whatever the user chose. null = user has not toggled.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const running = part.status === 'running';
  const expanded = userExpanded ?? running;
  const observedElapsed = useObservedElapsed(running);

  const settledMs = part.durationMs ?? (running ? null : observedElapsed);
  const shownMs = running ? observedElapsed : settledMs;
  const duration = shownMs != null && shownMs > MIN_SHOWN_MS ? formatDuration(shownMs) : null;
  const command = commandOf(part);
  const stateLabel = running ? 'running' : part.status === 'error' ? 'failed' : 'done';

  return (
    <div class={`agent-tool ${part.status}`}>
      <button type="button" class="tool-head" onClick={() => setUserExpanded(!expanded)}>
        <span class="tool-status" aria-hidden="true">
          {running ? <span class="tool-spinner" /> : part.status === 'error' ? '✕' : '✓'}
        </span>
        <span class="tool-name">{part.toolName}</span>
        {command && <code class="tool-cmd" title={command}>{command}</code>}
        <span class="tool-meta">
          {stateLabel}
          {duration && <span class="tool-duration">{duration}</span>}
        </span>
        <span class="tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div class="tool-body">
          {part.input !== undefined && <ToolPane label="Input" value={part.input} />}
          {part.output !== undefined && (
            <ToolPane label={part.status === 'error' ? 'Error' : 'Output'} value={part.output} />
          )}
          {part.error && part.output === undefined && <ToolPane label="Error" value={part.error} />}
        </div>
      )}
    </div>
  );
}

function ToolPane({ label, value }: { label: string; value: unknown }) {
  return (
    <div class="tool-pane">
      <span class="tool-pane-label">{label}</span>
      <pre>{prettyValue(value)}</pre>
    </div>
  );
}
