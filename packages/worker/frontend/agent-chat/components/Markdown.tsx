import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../markdown.js';

/**
 * Memoized markdown block: settled messages keep referential identity across
 * stream ticks, so their markdown is parsed exactly once.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="agent-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
