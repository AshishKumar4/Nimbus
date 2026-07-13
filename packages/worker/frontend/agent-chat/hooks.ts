/**
 * hooks.ts - Small presentation hooks shared by the chat components.
 */

import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';

/** Distance (px) from the bottom within which the view counts as pinned. */
const PIN_THRESHOLD = 40;

/**
 * Pin-to-bottom scrolling for a growing scroll container. While the reader
 * is at/near the bottom every content growth keeps the view glued there;
 * scrolling up unpins (no yanking mid-stream); returning re-pins.
 *
 * @param content value whose identity changes when the content grows
 * @returns callback ref for the scroll container
 */
export function usePinToBottom<T extends HTMLElement>(content: unknown): (node: T | null) => void {
  const el = useRef<T | null>(null);
  const pinned = useRef(true);
  // scrollTop as of our last observation. Content growth changes
  // scrollHeight but never scrollTop, so a differing value at effect time
  // means the user scrolled even if their scroll event hasn't fired yet
  // (renders committed from stream microtasks land before scroll events).
  const lastTop = useRef(0);

  const observe = useCallback(() => {
    const node = el.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    lastTop.current = node.scrollTop;
  }, []);

  const containerRef = useCallback((node: T | null) => {
    el.current?.removeEventListener('scroll', observe);
    el.current = node;
    if (node) {
      pinned.current = true;
      node.scrollTop = node.scrollHeight;
      lastTop.current = node.scrollTop;
      node.addEventListener('scroll', observe, { passive: true });
    }
  }, [observe]);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (node.scrollTop !== lastTop.current) observe();
    if (pinned.current) node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
  }, [content]);

  return containerRef;
}
