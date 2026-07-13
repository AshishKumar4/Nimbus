import { useLayoutEffect, useRef, useState } from 'preact/hooks';

const MAX_HEIGHT_PX = 220;

export interface ComposerProps {
  /** Chat is unavailable (not configured / not connected). */
  disabled: boolean;
  /** Inline hint shown when disabled (e.g. connect prompt). */
  hint: string | null;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ disabled, hint, streaming, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with the draft, clamped; beyond the clamp the textarea
  // scrolls internally.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  const canSend = !disabled && !streaming && draft.trim().length > 0;

  const submit = () => {
    if (streaming) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (disabled || !text) return;
    setDraft('');
    onSend(text);
  };

  return (
    <form
      class="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div class={`composer-card${disabled ? ' disabled' : ''}`}>
        <textarea
          id="agentInput"
          ref={textareaRef}
          rows={2}
          placeholder="Message Nimbus"
          value={draft}
          disabled={disabled}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div class="composer-row">
          <span class="composer-hint">{disabled && hint ? hint : 'Enter to send · Shift+Enter for a new line'}</span>
          <button
            id="agentSend"
            type="submit"
            class={streaming ? 'composer-send streaming' : 'composer-send'}
            disabled={!streaming && !canSend}
          >
            {streaming ? 'Stop' : 'Send'}
          </button>
        </div>
      </div>
    </form>
  );
}
