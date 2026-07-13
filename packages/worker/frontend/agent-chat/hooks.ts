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

  const onScroll = useCallback(() => {
    const node = el.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
  }, []);

  const containerRef = useCallback((node: T | null) => {
    el.current?.removeEventListener('scroll', onScroll);
    el.current = node;
    if (node) {
      pinned.current = true;
      node.scrollTop = node.scrollHeight;
      node.addEventListener('scroll', onScroll, { passive: true });
    }
  }, [onScroll]);

  useLayoutEffect(() => {
    const node = el.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [content]);

  return containerRef;
}
