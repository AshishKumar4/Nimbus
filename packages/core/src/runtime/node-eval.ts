/**
 * The code `node -e` and `node -p` run, as Node prepares it
 * (lib/internal/main/eval_string.js and eval_stdin.js, v22.22.3), for a
 * process that runs it as its entry module's body.
 *
 * `-p` prints the code's completion value: the value a script evaluates to,
 * which Node gets by running the code as a script (vm runInThisContext) and
 * prints with console.log when the process exits. An entry module's body
 * has no completion value, so the code is rewritten to hand it back: every
 * statement V8 would make the script's value assigns it to a variable
 * first, and the body returns that variable. Which statements those are is
 * V8's own rewrite, ported (src/parsing/rewriter.cc Processor): walking each
 * statement list backwards, the last value-producing statement assigns; a
 * statement that may complete without a value of its own (an `if` with no
 * value in one branch, a loop, a switch, a try) assigns `undefined` first;
 * past a `break` or `continue` the statements before it count again; and a
 * `finally` keeps the value it was entered with unless it breaks.
 *
 * Code with module syntax is not a script: Node runs it as a module and
 * refuses to print it (ERR_EVAL_ESM_CANNOT_PRINT), which the code becomes.
 * Nor is code with a `return` at its top, which Node refuses to compile.
 */

import { parse, type ModuleDeclaration, type Node, type Options, type Program, type Statement } from 'acorn';
import { full } from 'acorn-walk';

import { applySourceEdits, type SourceEdit } from './javascript-ast.js';

/** The code an eval runs, and when Node refuses it. */
export interface NodeEvalProgram {
  code: string;
  /**
   * Node refuses the code as it compiles it (a syntax error, or `-p` of
   * module syntax): after `-r`'s modules have run, before `--import`'s load
   * (eval_string.js compiles before run_main.js imports them). Known for
   * `-p`'s code, which is parsed here; `-e`'s is not.
   */
  refusedBeforeImports: boolean;
}

/**
 * The entry code for `node -e <code>`, or `-p`: with `print`, a body that
 * returns the code's completion value. Node keeps the identifier `crypto`
 * its node:crypto module in eval code, for backward compatibility, by
 * wrapping code that names it (eval_string.js: the same test, the same
 * wrappers).
 */
export function nodeEvalProgram(code: string, print: boolean): NodeEvalProgram {
  const namesCrypto = /\bcrypto\b/.test(code);
  if (!print) return { code: namesCrypto ? `(crypto=>{{${code}}})(require('node:crypto'))` : code, refusedBeforeImports: false };
  return printedProgram(namesCrypto ? `let crypto=require("node:crypto");{${code}}` : code);
}

/** The entry code for `node -p` reading its code from stdin (eval_stdin.js: no `crypto` wrapper). */
export function nodeStdinPrintProgram(source: string): NodeEvalProgram {
  return printedProgram(source);
}

const SCRIPT = { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true } as const;
const MODULE = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true } as const;

function parsed(source: string, options: Options): Program | null {
  try {
    return parse(source, options);
  } catch {
    return null;
  }
}

function printedProgram(source: string): NodeEvalProgram {
  const program = parsed(source, SCRIPT);
  if (program === null) {
    // Thrown as the program's first act, after its -r preloads, as Node
    // throws it; its stack leads with the code, as a Node error's does.
    if (parsed(source, MODULE) !== null) {
      return {
        code: 'const e = new Error("--print cannot be used with ESM input"); e.code = "ERR_EVAL_ESM_CANNOT_PRINT";'
          + ' e.name = "Error [ERR_EVAL_ESM_CANNOT_PRINT]"; e.stack; delete e.name; throw e;',
        refusedBeforeImports: true,
      };
    }
    // A return at the top compiles in the entry's function, not in Node's script.
    if (parsed(source, { ...SCRIPT, allowReturnOutsideFunction: true }) !== null) {
      return { code: 'throw new SyntaxError("Illegal return statement");', refusedBeforeImports: true };
    }
    // Neither: it fails to compile in the process, as it does in Node.
    return { code: source, refusedBeforeImports: true };
  }
  const rewriter = new CompletionRewriter(source, freshNames(program));
  rewriter.process(program.body, 0);
  return { code: `${rewriter.apply()}\n;var ${rewriter.declared.join(',')};return ${rewriter.result};`, refusedBeforeImports: false };
}

/**
 * Names for the rewrite's variables: `base`, or `base` and a number, naming
 * no identifier of the program, as the parser decoded it (`\u005f` is `_`),
 * nor one taken before.
 */
function freshNames(program: Program): (base: string) => string {
  const taken = new Set<string>();
  full(program, (node) => {
    if (node.type === 'Identifier') taken.add((node as Node & { name: string }).name);
  });
  return (base) => {
    let name = base;
    for (let n = 1; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  };
}

/** Text inserted at `at`: closings before openings there, inner closings first, outer openings first. */
interface Insertion {
  at: number;
  text: string;
  close: boolean;
  depth: number;
}

type Loop = Extract<Statement, { type: 'WhileStatement' | 'DoWhileStatement' | 'ForStatement' | 'ForInStatement' | 'ForOfStatement' }>;
const LOOPS = new Set<string>(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);

/** V8's Processor (src/parsing/rewriter.cc), over ESTree, as source insertions. */
class CompletionRewriter {
  /** A later statement already decides the value. */
  private isSet = false;
  /** Inside a loop, a switch or a labelled statement: a `break` can leave from anywhere. */
  private breakable = false;
  private readonly insertions: Insertion[] = [];
  /** The variable holding the value. */
  readonly result: string;
  /** The variables the rewritten code declares: the value's, and each finally block's saved value. */
  readonly declared: string[];

  constructor(private readonly source: string, private readonly fresh: (base: string) => string) {
    this.result = fresh('__nimbus_print_result');
    this.declared = [this.result];
  }

  apply(): string {
    const ordered = [...this.insertions].sort((a, b) => a.at - b.at
      || (a.close === b.close ? (a.close ? b.depth - a.depth : a.depth - b.depth) : a.close ? -1 : 1));
    const edits: SourceEdit[] = ordered.map(({ at, text }) => ({ start: at, end: at, text }));
    return applySourceEdits(this.source, edits);
  }

  /** A statement list, backwards: only up to its last value, unless a `break` can skip that. A script's has no module declarations. */
  process(statements: readonly (Statement | ModuleDeclaration)[], depth: number): void {
    for (let i = statements.length - 1; i >= 0 && (this.breakable || !this.isSet); i--) {
      this.visit(statements[i], depth);
    }
  }

  /**
   * `wrap`: what assigning `undefined` before `node` wraps, `node` itself
   * or the labels in front of it (a `continue` must still name a loop).
   */
  private visit(node: Statement | ModuleDeclaration, depth: number, wrap: Node = node): void {
    switch (node.type) {
      case 'BlockStatement':
        this.process(node.body, depth + 1);
        return;
      case 'ExpressionStatement': {
        if (this.isSet) return;
        const expression = node.expression;
        if (node.directive !== undefined) {
          // A directive stays one ("use strict" decides the code's mode): its value is assigned after it.
          this.insert(node.end, `;${this.result}=(0,${this.source.slice(expression.start, expression.end)});`, true, depth);
        } else {
          // `(0, e)`: an anonymous function or class is not named after the variable.
          this.insert(expression.start, `${this.result}=(0,`, false, depth);
          this.insert(expression.end, ')', true, depth);
        }
        this.isSet = true;
        return;
      }
      case 'IfStatement': {
        const setAfter = this.isSet;
        this.visit(node.consequent, depth + 1);
        const setInThen = this.isSet;
        this.isSet = setAfter;
        if (node.alternate) this.visit(node.alternate, depth + 1);
        if (!(setInThen && this.isSet)) this.undefinedBefore(wrap, depth);
        this.isSet = true;
        return;
      }
      case 'SwitchStatement':
        this.breakably(() => {
          for (let i = node.cases.length - 1; i >= 0; i--) this.process(node.cases[i].consequent, depth + 1);
        });
        this.undefinedBefore(wrap, depth);
        this.isSet = true;
        return;
      case 'TryStatement':
        this.visitTry(node, depth);
        return;
      case 'WithStatement':
        this.visit(node.body, depth + 1);
        if (!this.isSet) this.undefinedBefore(wrap, depth);
        this.isSet = true;
        return;
      case 'LabeledStatement':
        this.breakably(() => this.visit(node.body, depth + 1, wrap));
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        this.isSet = false;
        return;
      case 'ThrowStatement':
        this.isSet = true;
        return;
      default:
        if (LOOPS.has(node.type)) {
          this.breakably(() => this.visit((node as Loop).body, depth + 1));
          this.undefinedBefore(wrap, depth);
          this.isSet = true;
        }
        // Declarations, `;` and `debugger` have no value.
    }
  }

  /**
   * V8's TryCatchStatement and TryFinallyStatement (a try with both is a
   * try-finally around a try-catch). Assigning `undefined` before a try is
   * the try block's first statement: nothing between them can throw.
   */
  private visitTry(node: Extract<Statement, { type: 'TryStatement' }>, depth: number): void {
    const undefinedFirst = () => this.insert(node.block.start + 1, `${this.result}=void 0;`, false, depth);
    if (node.finalizer) {
      // A finally block's own values count only up to a break or continue out of it.
      if (this.breakable) {
        this.isSet = true;
        this.process(node.finalizer.body, depth + 1);
        if (this.isSet) {
          // Kept and restored, in a variable of its own: the finally block
          // does not change the value it was entered with.
          const backup = this.fresh('__nimbus_print_backup');
          this.declared.push(backup);
          this.insert(node.finalizer.start + 1, `${backup}=${this.result};`, false, depth);
          this.insert(node.finalizer.end - 1, `;${this.result}=${backup};`, true, depth);
        } else {
          // It breaks or continues with no value of its own before: the
          // try statement's value is undefined.
          this.insert(node.finalizer.start + 1, `${this.result}=void 0;`, false, depth);
        }
        this.isSet = false;
      }
    }
    if (node.handler) {
      const setAfter = this.isSet;
      this.process(node.block.body, depth + 1);
      const setInTry = this.isSet;
      this.isSet = setAfter;
      this.process(node.handler.body.body, depth + 1);
      if (!(this.isSet && setInTry)) undefinedFirst();
      this.isSet = true;
      if (!node.finalizer) return;
    } else {
      this.process(node.block.body, depth + 1);
    }
    if (!this.isSet) undefinedFirst();
    this.isSet = true;
  }

  private breakably(walk: () => void): void {
    const previous = this.breakable;
    this.breakable = true;
    try { walk(); } finally { this.breakable = previous; }
  }

  /** `{ result = undefined; <wrap> }`: the statement may complete with no value of its own. */
  private undefinedBefore(wrap: Node, depth: number): void {
    this.insert(wrap.start, `{${this.result}=void 0;`, false, depth);
    this.insert(wrap.end, '}', true, depth);
  }

  private insert(at: number, text: string, close: boolean, depth: number): void {
    this.insertions.push({ at, text, close, depth });
  }
}
