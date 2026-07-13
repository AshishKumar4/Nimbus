/**
 * index.tsx - Entry for the Nimbus agent-chat island, bundled by
 * scripts/bundle-agent-chat.mjs into /_assets/agent-chat/agent-chat.js.
 *
 * The shell (public/s/index.html) dynamic-imports this module and calls
 * ensureLoaded() when the Agent surface is selected, and renderMarkdown()
 * for the #markdown-preview pane - one markdown pipeline for everything.
 */

import { render } from 'preact';
import { AgentChat } from './components/AgentChat.js';
import { renderMarkdown } from './markdown.js';
import './agent-chat.css';

export { renderMarkdown };

let mounted = false;
let refreshChat: (() => void) | null = null;

/**
 * Mount the chat island into #agentPanel on first call; subsequent calls
 * re-sync status and history (the shell calls this on every surface switch).
 */
export function ensureLoaded(): void {
  if (mounted) {
    refreshChat?.();
    return;
  }
  const host = document.getElementById('agentPanel');
  if (!host) throw new Error('agent-chat: #agentPanel mount node is missing');
  mounted = true;
  render(
    <AgentChat onReady={(refresh) => { refreshChat = refresh; }} />,
    host,
  );
}

declare global {
  interface Window {
    NimbusAgent: { ensureLoaded(): void };
    __nimbusMarkdown: { render(text: string): string };
  }
}

window.NimbusAgent = { ensureLoaded };
window.__nimbusMarkdown = { render: renderMarkdown };
