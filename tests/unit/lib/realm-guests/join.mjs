// The guest side's joinRealm, from the source under Bun and the built package under Node.
const { joinRealm } = await import(typeof process.versions.bun === 'string'
  ? '../../../../packages/core/src/runtime/realm-guest.ts'
  : '../../../../packages/core/dist/runtime/realm-guest.js');
export { joinRealm };
