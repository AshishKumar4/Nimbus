import { useLayoutEffect, useRef } from 'preact/hooks';

const MAX_HEIGHT_PX = 220;

export interface ComposerProps {
  /** Draft text - owned by the parent so failed sends can restore it. */
  value: string;
  onChange(value: string): void;
  /** Chat is unavailable (not configured / not connected). */
  disabled: boolean;
  /** Inline hint shown when disabled (e.g. connect prompt). */
  hint: string | null;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ value, onChange, disabled, hint, streaming, onSend, onStop }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with the draft, clamped; beyond the clamp the textarea
  // scrolls internally.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const canSend = !disabled && !streaming && value.trim().length > 0;

  // Enter never stops an in-flight turn - composing the next message and
  // hitting Enter while streaming is a no-op. Stop is button-only.
  const trySend = () => {
    const text = value.trim();
    if (disabled || streaming || !text) return;
    onSend(text);
  };

  return (
    <form
      class="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (streaming) onStop();
        else trySend();
      }}
    >
      <div class={`composer-card${disabled ? ' disabled' : ''}`}>
        <textarea
          id="agentInput"
          ref={textareaRef}
          rows={2}
          placeholder="Message Nimbus"
          value={value}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              trySend();
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
