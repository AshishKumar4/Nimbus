/**
 * Route a cell's import() to the process's ESM loader and bind import.meta to
 * its evaluation metadata. Worker Loader does not resolve VFS packages.
 *
 * Acorn's parser drives its lexer: a standalone token stream cannot know
 * whether await or a keyword-named member permits a regexp or division.
 * Collect imports as the upstream parser recognizes them, rather than walking
 * the AST afterward, and discard completed top-level trees. This keeps large
 * bundles cheap without maintaining a second JavaScript grammar.
 */
import { Parser, type Node, type Program } from 'acorn';

export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';

export function mayHaveDynamicImport(code: string): boolean {
  return /\bimport\s*(?:\(|\/[/*])/.test(code);
}

interface Edit { start: number; end: number; text: string }
interface ImportCall { start: number; end: number }

export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const call = DYNAMIC_IMPORT_HELPER + '(' + JSON.stringify(parentUrl) + ', ';
  const edits: Edit[] = [];
  const metas: ImportCall[] = [];
  const names = metadata ? new Set<string>() : null;
  let StreamingParser = Parser.extend(Base => {
    const parseStatement = Reflect.get(Base.prototype, 'parseStatement');
    const parseDynamicImport = Reflect.get(Base.prototype, 'parseDynamicImport');
    return class extends Base {
      parseDynamicImport(node: Node): Node {
        // Acorn enters this production at the opening parenthesis. Its end,
        // not source.start (which can exclude grouping parentheses), is the
        // exact end of the prefix we replace. Acorn validates the arguments.
        const end = Reflect.get(this, 'end') as number;
        const parsed: Node = Reflect.apply(parseDynamicImport, this, [node]);
        edits.push({ start: node.start, end, text: call });
        return parsed;
      }
      parseStatement(context: unknown, topLevel: boolean, exports: unknown): Node {
        const node: Node = Reflect.apply(parseStatement, this, [context, topLevel, exports]);
        if (!topLevel) return node;
        if (node.type === 'ExpressionStatement') {
          const expression = Reflect.get(node, 'expression');
          if (expression?.type === 'Literal' && typeof expression.value === 'string') return node;
        }
        return { type: 'EmptyStatement', start: node.start, end: node.end };
      }
    };
  });
  // The capture must not shadow user bindings, including escaped identifiers.
  // Import-only cells need no identifier collection.
  if (metadata) StreamingParser = StreamingParser.extend(Base => {
    const parseIdent = Reflect.get(Base.prototype, 'parseIdent');
    const parseImportMeta = Reflect.get(Base.prototype, 'parseImportMeta');
    return class extends Base {
      parseImportMeta(node: Node): Node {
        const parsed: Node = Reflect.apply(parseImportMeta, this, [node]);
        metas.push({ start: node.start, end: node.end });
        return parsed;
      }
      parseIdent(liberal: boolean): Node {
        const node: Node = Reflect.apply(parseIdent, this, [liberal]);
        names!.add(Reflect.get(node, 'name'));
        return node;
      }
    };
  });
  for (const sourceType of metadata ? ['module', 'script'] as const : ['script', 'module'] as const) {
    edits.length = 0; metas.length = 0; names?.clear();
    let program: Program;
    try {
      program = StreamingParser.parse(code, {
        ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true, allowHashBang: true,
      });
    } catch { continue; }
    let insertion = program.body[0]?.start ?? code.length;
    for (const statement of program.body) {
      if (typeof Reflect.get(statement, 'directive') !== 'string') break;
      insertion = statement.end;
    }
    return applyEdits(code, edits, metas, names, insertion);
  }
  return code;
}

function applyEdits(code: string, edits: Edit[], metas: ImportCall[], names: Set<string> | null, insertion: number): string {
  if (metas.length) {
    let binding = '__nimbusMetadataModule';
    while (names!.has(binding)) binding += '_';
    for (const meta of metas) edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
    edits.push({ start: insertion, end: insertion, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
  }
  if (!edits.length) return code;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: string[] = [];
  let at = 0;
  for (const { start, end, text } of edits) {
    parts.push(code.slice(at, start), text);
    at = end;
  }
  parts.push(code.slice(at));
  return parts.join('');
}
