/**
 * Stub for the legacy `@lifo-sh/ui` import path.
 *
 * Nimbus embeds its own browser terminal shell from `public/`; the Worker
 * runtime only needs `@lifo-sh/core`. Some upstream core code still has a
 * lazy `@lifo-sh/ui` import, so embedders alias that specifier here during
 * Wrangler bundling.
 */
export {};
//# sourceMappingURL=lifo-ui.d.ts.map