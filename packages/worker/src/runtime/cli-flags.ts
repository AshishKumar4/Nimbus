export function hasLeadingCliFlag(
  argv: readonly string[],
  flags: ReadonlySet<string>,
): boolean {
  for (const arg of argv) {
    if (flags.has(arg)) return true;
    if (arg === '--' || arg === '-c' || arg === '-m' || arg === '-') return false;
    if (!arg.startsWith('-')) return false;
  }
  return false;
}
