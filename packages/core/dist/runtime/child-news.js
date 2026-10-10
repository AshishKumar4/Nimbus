/**
 * Source of the guest's half of the Dynamic Worker ledger's news protocol
 * (fabric budgets.ts ProcessNews): what a program has applied of the news of
 * its children, and what it says of itself.
 *
 * The session numbers each piece of news of a program's children as it is
 * produced (a child's start, its output, the end of a stream, its exit), and
 * the reply that delivers a piece carries its number. Once a reply's effect
 * is applied (the bytes written, 'exit' emitted), its numbers are applied
 * here; the frontier is the contiguous run of numbers applied from 1,
 * whatever order the replies came in. A report says whether the program is
 * blocked (its only remaining work is waiting on its children) and at which
 * frontier, numbered so a late one is dropped; it is sent only when what it
 * says changes, and never "running" before anything was said.
 *
 * `createChildNews(send)` returns the program's tracker; `send(report)`
 * delivers a report to the session, in order. generateShimsCode embeds this
 * text once, and tests/unit/lib/ledger-protocol-model.mjs evaluates the same
 * text, so the model checks the guest the session talks to. A string, not a
 * function's toString(): tsc and bun print function source differently (see
 * javascript-string-literal.ts).
 */
export const CHILD_NEWS_SOURCE = String.raw `function createChildNews(send) {
  let frontier = 0;
  const ahead = new Set();
  let said = "";
  let seq = 0;
  return {
    apply(numbers) {
      if (!Array.isArray(numbers)) return;
      for (const n of numbers) if (typeof n === "number" && n > frontier) ahead.add(n);
      while (ahead.delete(frontier + 1)) frontier++;
    },
    say(blocked) {
      const key = blocked ? "blocked@" + frontier : "running";
      if (key === said || (!blocked && said === "")) return;
      said = key;
      send({ blocked: blocked === true, frontier, seq: ++seq });
    },
    inspect() {
      return { frontier, ahead: [...ahead].sort((a, b) => a - b), said, seq };
    },
  };
}`;
