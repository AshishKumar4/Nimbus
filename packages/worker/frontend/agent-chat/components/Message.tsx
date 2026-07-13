import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type { AgentTurnUsage, StoredMessage, StoredToolPart, StoredTurnPart } from '../../../src/session/agent-contract.js';
import { Markdown } from './Markdown.js';
import { ToolCard } from './ToolCard.js';

export interface MessageProps {
  message: StoredMessage;
  /** True for the in-flight assistant turn (cursor + thinking affordances). */
  live?: boolean;
  /** Monotonic stream tick - defeats memo for the live message only. */
  tick?: number;
  usage?: AgentTurnUsage | null;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatTokens(count: number): string {
  return count >= 10_000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function usageLabel(usage: AgentTurnUsage | null | undefined): string | null {
  if (!usage) return null;
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  return total > 0 ? `${formatTokens(total)} tokens` : null;
}

function messageParts(message: StoredMessage): StoredTurnPart[] {
  if (Array.isArray(message.parts)) {
    return message.parts.filter((part): part is StoredTurnPart => !!part && typeof part === 'object');
  }
  return message.content ? [{ type: 'text', text: message.content }] : [];
}

/** Pre-parts era: tool results were stored as their own `tool`-role rows. */
function legacyToolPart(message: StoredMessage): StoredToolPart {
  let payload: { tool?: string; input?: unknown; output?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(message.content || '{}');
    if (parsed && typeof parsed === 'object') payload = parsed;
  } catch {
    payload = { output: message.content };
  }
  const output = payload.output ?? message.content;
  return {
    type: 'tool',
    toolCallId: message.id,
    toolName: payload.tool || message.name || 'tool',
    input: payload.input,
    output,
    status: 'done',
  };
}

function hasVisibleContent(parts: StoredTurnPart[]): boolean {
  return parts.some((part) => part.type === 'tool' || part.text.length > 0);
}

function lastTextIndex(parts: StoredTurnPart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'text' && part.text) return i;
  }
  return -1;
}

export const Message = memo(function Message({ message, live, usage }: MessageProps) {
  if (message.role === 'user') {
    return (
      <div class="agent-msg user">
        <div class="agent-bubble">{message.content}</div>
        <div class="agent-meta">{formatTime(message.createdAt)}</div>
      </div>
    );
  }

  const parts = message.role === 'tool' ? [legacyToolPart(message)] : messageParts(message);

  if (live && !hasVisibleContent(parts)) {
    return (
      <div class="agent-msg assistant">
        <div class="agent-content">
          <ThinkingDots />
        </div>
      </div>
    );
  }

  const cursorIndex = live ? lastTextIndex(parts) : -1;
  // Between a settled tool and the model's next token there is nothing
  // visibly in flight - show the thinking dots in that gap only.
  const lastPart = parts[parts.length - 1];
  const trailingThinking = live && lastPart?.type === 'tool' && lastPart.status !== 'running';
  const tokens = usageLabel(usage);

  return (
    <div class="agent-msg assistant">
      <div class="agent-content">
        {parts.map((part, index) => {
          if (part.type === 'reasoning') {
            return part.text ? <Reasoning key={`r${index}`} text={part.text} /> : null;
          }
          if (part.type === 'tool') {
            return <ToolCard key={part.toolCallId} part={part} />;
          }
          if (!part.text) return null;
          return (
            <div key={`t${index}`} class="agent-text">
              <Markdown text={part.text} />
              {index === cursorIndex && <span class="agent-cursor" />}
            </div>
          );
        })}
        {trailingThinking && <ThinkingDots />}
        {!live && (
          <div class="agent-meta">
            {formatTime(message.createdAt)}
            {message.aborted && <span class="agent-stopped">stopped</span>}
            {tokens && <span class="agent-usage">{tokens}</span>}
          </div>
        )}
      </div>
    </div>
  );
});

function Reasoning({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div class="agent-reasoning">
      <button type="button" class="reasoning-head" onClick={() => setExpanded(!expanded)}>
        <span>Thinking</span>
        <span class="tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      <div class={`reasoning-body${expanded ? '' : ' clamped'}`}>{text}</div>
    </div>
  );
}

export function ThinkingDots() {
  return (
    <div class="agent-thinking">
      <span class="dots"><span /><span /><span /></span>
      <span>Thinking...</span>
    </div>
  );
}
