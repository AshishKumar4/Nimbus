// @serial
// @tier slow — drives a local workerd
// A CommonJS program whose SyntaxError is at the end of its source (a call,
// block, bracket or expression left open, a template, a comment) is reported
// as Node reports it, compiling the source alone (wrapSafe): its line, its
// arrow (an argument list's last token, a parenthesized rest's ellipsis, or
// nothing underlined at the end) and V8's message for the end of the input,
// run from a file, with a trailing newline or a shebang, and from stdin; and
// required, with a stack formatter of the program's own (Node's message
// reaches it; a formatter's own text is kept). Host Node is the oracle.
//
// Red before: the cell's wrapper followed the source, so V8 read its tail
// where the source ends: the arrow showed the wrapper's `}; });`, a line
// past the source, and the message was the tail's ("Unexpected token '}'").
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const sources = {
  'call.js': 'console.log("ran"',
  'call-nl.js': 'console.log("ran"\n',
  'open-call.js': 'syntax(',
  'mid.js': 'const x = ;\nconsole.log("ran");\n',
  'tamper.js': 'syntax(',
  'block.js': 'function f() {',
  'if.js': 'if (x',
  'array.js': 'const a = [1, 2',
  'string.js': 'const s = "unterminated',
  'comment.js': '/* comment',
  'template.js': 'const t = `tmpl',
  'object.js': '({a: 1',
  'comma.js': 'f(1,',
  'plus.js': 'x = 1 +',
  'second-line.js': 'a\nb(c',
  'shebang.js': '#!/usr/bin/env node\nconsole.log("ran"\n',
  // Strict code of its own, which the runner compiles as an ES module (core commonjs-cell.ts THE WRAPPER).
  'strict-call.js': '"use strict";\nconsole.log("ran"',
  'strict-mid.js': '"use strict";\nconst x = ;\nconsole.log("ran");\n',
  'strict-block.js': '"use strict";\nfunction f() {',
  'strict-shebang.js': '#!/usr/bin/env node\n"use strict";\nf(1,',
  'strict-required.js': [
    "for (const name of ['./strict-mid.js', './strict-call.js']) {",
    '  try { require(name); } catch (error) { console.log(error instanceof SyntaxError, error.message); console.log(error.stack.split(\'\\n\').slice(0, 5).join(\'\\n\')); }',
    '}',
    "console.log('after');",
    '',
  ].join('\n'),
  // V8 names a parenthesized rest's ellipsis, in the source, where no arrow follows it.
  'rest.js': '(...args',
  'rest-param.js': 'f = (a, ...b',
  'rest-object.js': 'f(a, (...{b',
  'rest-array.js': '(...[a, ...b]',
  'formatter.js': [
    'Error.prepareStackTrace = (error) => `formatted ${error.message}`;',
    "try { require('./open-call.js'); } catch (error) { console.log(error.message); console.log(error.stack); }",
    `Error.prepareStackTrace = () => "literal Unexpected token '}'";`,
    "try { require('./open-call.js'); } catch (error) { console.log(error.message); console.log(error.stack); }",
    '',
  ].join('\n'),
  // Each require() compiles the module again: a new SyntaxError, where it is (ticket-cell-compile-error-identity).
  'again.js': [
    "for (const name of ['./open-call.js', './mid.js']) {",
    '  const errors = [];',
    '  for (let i = 0; i < 2; i++) try { require(name); } catch (error) { errors.push(error); }',
    "  console.log(name, errors[0] === errors[1], errors[1] instanceof SyntaxError, errors[1].message);",
    "  console.log(errors[1].stack.split('\\n').slice(0, 5).join('\\n'));",
    '}',
    // What the program does to the first error, or to the global SyntaxError, reaches no later one.
    'let first;',
    "try { require('./tamper.js'); } catch (error) { first = error; }",
    "Object.defineProperty(first, 'message', { get() { throw 123; } });",
    'const Native = SyntaxError;',
    'globalThis.SyntaxError = function SyntaxError() { return { fake: true }; };',
    "try { require('./tamper.js'); } catch (error) { console.log(error instanceof Native, error.fake, error.message); console.log(error.stack.split('\\n').slice(0, 5).join('\\n')); }",
    'globalThis.SyntaxError = Native;',
    '',
  ].join('\n'),
};
const commands = [
  ...Object.keys(sources).map((name) => `node ${name}`),
  // Without type stripping: Node adds its TypeScript stripper's own message
  // for stdin and eval (ticket-eval-syntax-typescript-hint), a different report.
  "echo 'syntax(' | node --no-experimental-strip-types",
  "printf 'console.log(1' | node --no-experimental-strip-types",
];
await matchNodeInWorkerd('commonjs-eof-syntax', '/home/user/eof', sources, commands);
console.log(`ok - commonjs-eof-syntax-workerd (${commands.length} programs, as host Node reports them)`);
