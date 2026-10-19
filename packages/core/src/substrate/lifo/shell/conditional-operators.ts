/** The binary operators of `test` and `[[ ]]` (`=~` is `[[ ]]`'s alone, read by its parser). */
export const BINARY_OPERATORS: Readonly<Record<string, true>> = {
  '=': true, '==': true, '!=': true, '<': true, '>': true,
  '-eq': true, '-ne': true, '-lt': true, '-le': true, '-gt': true, '-ge': true,
};

// POSIX unary primaries; -h and -L are the same symlink test.
export const UNARY_OPERATORS: Readonly<Record<string, true>> = {
  '-b': true, '-c': true, '-d': true, '-e': true, '-f': true, '-g': true, '-h': true, '-k': true, '-L': true,
  '-n': true, '-p': true, '-r': true, '-s': true, '-S': true, '-t': true, '-u': true, '-w': true, '-x': true, '-z': true,
};
