/**
 * bash 5's builtins: in bash these run in the shell's own process, and `type`
 * and `command -v` name one as a builtin before any file of its name on PATH.
 */
export const BASH_BUILTINS = new Set([
    '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete',
    'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false',
    'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source',
    'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);
