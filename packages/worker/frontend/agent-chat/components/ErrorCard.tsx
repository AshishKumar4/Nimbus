export interface ErrorCardProps {
  message: string;
  streaming: boolean;
  /** Action label - "Send again" for an unsent draft, retry otherwise. */
  retryLabel: string;
  onRetry(): void;
  onDismiss(): void;
}

/**
 * Terminal turn error: the last turn failed and produced no persisted
 * answer. Shows the honest error body with a retry affordance.
 */
export function ErrorCard({ message, streaming, retryLabel, onRetry, onDismiss }: ErrorCardProps) {
  return (
    <div class="agent-error-card">
      <div class="error-title">The last turn failed</div>
      <code class="error-body">{message}</code>
      <div class="error-actions">
        <button type="button" class="error-dismiss" onClick={onDismiss}>Dismiss</button>
        <button type="button" class="error-retry" disabled={streaming} onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    </div>
  );
}
