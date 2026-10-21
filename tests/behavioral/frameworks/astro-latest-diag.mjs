// Scratch forensics, bounded to the failing launch so its complete process
// output and the runtime audit fit in the runner's 64 KiB verdict receipt.
process.env.NIMBUS_ASTRO_DIAG_LATEST_ONLY='1';
await import('./astro-versions-diag.mjs');
