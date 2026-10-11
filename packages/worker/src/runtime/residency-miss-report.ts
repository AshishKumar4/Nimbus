/** The guest and the supervisor report an unanswered synchronous read alike. */
export function residencyMissReport(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const named = keys.slice(0, 20);
  return 'node: ' + keys.length + ' file(s) were read synchronously but their content was '
    + 'never staged into the process, so every one of those reads failed and the program '
    + 'carried on without the bytes. Failing rather than reporting a result built on them:\n'
    + named.map((key) => '  /' + key + '\n').join('')
    + (keys.length > named.length ? '  ... and ' + (keys.length - named.length) + ' more\n' : '')
    + 'The files exist and an async read (fs.promises.readFile) returns them now; the next '
    + 'run of the same command stages them up front.\n';
}
