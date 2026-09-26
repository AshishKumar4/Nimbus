import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const leanRoot = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(leanRoot, "..");

const sourceRoot = join(leanRoot, "Nimbus");

const axiomAuditPath = join(sourceRoot, "Axioms.lean");

const traceabilityPath = join(leanRoot, "traceability.yaml");

const allowedKernelAxioms = new Set(["propext", "Classical.choice", "Quot.sound"]);

const allowedStatuses = new Set([
  "proved-and-refined",
  "proved-in-abstract-model",
  "by-construction-witness",
  "trusted-model-assumption",
  "specified-not-modeled",
]);

// `proved-and-refined` is a proof plus a bridge to the deployed code: each entry of
// its `refinement` list pairs a fixture the model generated with the unit test
// that runs the deployed TypeScript on it. `scripts/verify-lean.sh` regenerates every
// fixture from the model and runs every named test, so the status cannot outlive
// either half. What a fixture does NOT show is agreement on inputs it does not
// contain: the bridge is a finite sample, and the proof covers the model alone.
const fixtureRoot = join(leanRoot, "fixtures");

const refinementPattern =
  /^(lean\/fixtures\/([a-z0-9-]+)\.json) :: (tests\/unit\/[A-Za-z0-9._-]+\.mjs)$/;

const qualifiedNamePattern = /^Nimbus(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/;

const leanConstructorPattern = /\|\s*([A-Za-z_][A-Za-z0-9_']*)/g;

function leanConstructors(text) {
  return [...text.matchAll(leanConstructorPattern)].map((match) => match[1]);
}

// --manifest-only stops before the kernel axiom audit, which needs a built Lean
// toolchain. Everything up to that point is pure file reading: the manifest is
// well-formed, every tsRef still resolves to a live TypeScript declaration,
// every declared state mirror still matches the set the code ships, and every
// claimed theorem/axiom exists as an exact source declaration. That is the
// drift check a deploy gate can afford; scripts/verify-lean.sh runs the full
// audit.
const manifestOnly = process.argv.includes("--manifest-only");

const failures = [];

function fail(message) {
  failures.push(message);
}

function exitOnFailures() {
  if (failures.length === 0) return;

  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

function parseTraceability(source) {
  const requirements = new Map();
  let inRequirements = false;
  let current;
  let listKey;

  for (const [index, rawLine] of source.split("\n").entries()) {
    const lineNumber = index + 1;

    if (/^\s*(?:#.*)?$/.test(rawLine)) continue;

    if (rawLine === "requirements:") {
      inRequirements = true;
      current = undefined;
      listKey = undefined;
      continue;
    }

    if (!inRequirements) continue;

    const requirement = rawLine.match(/^  ([A-Z][A-Z0-9-]+):\s*$/);

    if (requirement) {
      const id = requirement[1];

      if (requirements.has(id)) fail(`duplicate requirement id at line ${lineNumber}: ${id}`);
      current = {
        id,
        fields: new Set(),
        theorems: [],
        axioms: [],
        tsRefs: [],
        remainingEvidence: [],
        refinement: [],
      };
      requirements.set(id, current);
      listKey = undefined;
      continue;
    }

    const field = rawLine.match(/^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);

    if (field && current) {
      const [, key, rawValue = ""] = field;

      if (current.fields.has(key)) fail(`duplicate field at line ${lineNumber}: ${current.id}.${key}`);
      current.fields.add(key);

      if (["theorems", "axioms", "tsRefs", "remainingEvidence", "refinement"].includes(key)) {
        if (rawValue !== "" && rawValue !== "[]") {
          fail(`unsupported inline list at line ${lineNumber}: ${key}`);
        }

        current[key] = [];
        listKey = rawValue === "[]" ? undefined : key;
      } else {
        if (rawValue === "") fail(`missing scalar value at line ${lineNumber}: ${key}`);
        current[key] = rawValue;
        listKey = undefined;
      }

      continue;
    }

    const item = rawLine.match(/^      - (\S(?:.*\S)?)\s*$/);

    if (item && current && listKey) {
      current[listKey].push(item[1]);
      continue;
    }

    fail(`unrecognized traceability syntax at line ${lineNumber}: ${rawLine.trim()}`);
  }

  return requirements;
}

function stripLeanComments(source) {
  let output = "";
  let blockDepth = 0;
  let lineComment = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }

      continue;
    }

    if (blockDepth > 0) {
      if (char === "/" && next === "-") {
        blockDepth += 1;
        i += 1;
      } else if (char === "-" && next === "/") {
        blockDepth -= 1;
        i += 1;
      } else if (char === "\n") {
        output += char;
      }

      continue;
    }

    if (inString) {
      output += char;

      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "-") {
      blockDepth = 1;
      i += 1;
    } else {
      output += char;
    }
  }

  return output;
}

function stripLeanAttributes(source) {
  let output = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let sourceString = false;
  let sourceEscaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (depth === 0) {
      if (!sourceString && char === "@" && next === "[") {
        output += "  ";
        depth = 1;
        i += 1;
        continue;
      }

      output += char;

      if (sourceString) {
        if (sourceEscaped) sourceEscaped = false;
        else if (char === "\\") sourceEscaped = true;
        else if (char === '"') sourceString = false;
      } else if (char === '"') {
        sourceString = true;
      }

      continue;
    }

    if (char === "\n") {
      output += char;
      continue;
    }

    output += " ";

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
  }

  if (depth !== 0) fail("unterminated Lean attribute block while scanning declarations");

  return output;
}

function walkLeanSources(directory) {
  const paths = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      if (directory === leanRoot && [".lake", "scratch-verification"].includes(entry)) continue;
      paths.push(...walkLeanSources(path));
    } else if (entry.endsWith(".lean") && !(directory === leanRoot && entry === "lakefile.lean")) {
      paths.push(path);
    }
  }

  return paths;
}

function collectDeclarations(paths) {
  const theorems = new Set();
  const axioms = new Set();
  const inductives = new Map();

  for (const path of paths) {
    const source = stripLeanAttributes(stripLeanComments(readFileSync(path, "utf8")));

    if (/\bsorry\b/.test(source)) {
      fail(`source contains a sorry placeholder: ${relativePath(path)}`);
    }

    let namespace = [];
    const scopes = [];
    // Set while the lines after an `inductive` may still carry constructors.
    let collecting;

    for (const [lineIndex, line] of source.split("\n").entries()) {
      if (collecting !== undefined) {
        if (/^\s*\|/.test(line)) {
          collecting.push(...leanConstructors(line));
          continue;
        }

        if (line.trim() !== "") collecting = undefined;
      }

      const inductiveMatch = line.match(/^\s*inductive\s+([A-Za-z_][A-Za-z0-9_']*)\b(.*)$/);

      if (inductiveMatch) {
        // Constructors sit on the `inductive` line itself, or on the `|` lines
        // under it, or both. Doc comments between two constructors are already
        // blank here, so a blank line continues rather than ends the list.
        const constructors = leanConstructors(inductiveMatch[2]);
        inductives.set([...namespace, inductiveMatch[1]].join("."), { path, constructors });
        collecting = constructors;
        continue;
      }

      const namespaceMatch = line.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_'.]*)\s*$/);

      if (namespaceMatch) {
        const components = namespaceMatch[1].split(".");
        namespace.push(...components);
        scopes.push({ kind: "namespace", count: components.length });
        continue;
      }

      if (/^\s*section(?:\s+[A-Za-z_][A-Za-z0-9_']*)?\s*$/.test(line)) {
        scopes.push({ kind: "section", count: 0 });
        continue;
      }

      const endMatch = line.match(/^\s*end(?:\s+([A-Za-z_][A-Za-z0-9_'.]*))?\s*$/);

      if (endMatch) {
        const scope = scopes.pop();

        if (!scope) {
          fail(`unmatched end while scanning ${relativePath(path)}:${lineIndex + 1}`);
        } else if (scope.kind === "namespace") {
          namespace = namespace.slice(0, namespace.length - scope.count);
        }

        continue;
      }

      const declarationMatch = line.match(
        /^\s*((?:(?:private|protected|noncomputable|unsafe)\s+)*)(theorem|axiom)\s+([A-Za-z_][A-Za-z0-9_']*)\b/,
      );

      if (!declarationMatch) continue;
      const [, modifiers, kind, localName] = declarationMatch;

      if (/\bprivate\b/.test(modifiers)) {
        if (kind === "axiom") {
          fail(`private axiom is forbidden because it cannot be enrolled under a stable qualified name: ${relativePath(path)}:${lineIndex + 1}`);
        }

        continue;
      }

      const qualifiedName = [...namespace, localName].join(".");

      if (kind === "theorem") theorems.add(qualifiedName);
      else axioms.add(qualifiedName);
    }

    if (scopes.length !== 0) fail(`unclosed namespace or section while scanning ${relativePath(path)}`);
  }

  return { theorems, axioms, inductives };
}

function collectExpectedAxiomReports(source) {
  const expected = new Map();
  const names = new Set();

  for (const [index, line] of stripLeanComments(source).split("\n").entries()) {
    const match = line.match(/^\s*#print\s+axioms\s+(Nimbus(?:\.[A-Za-z_][A-Za-z0-9_']*)+)\s*$/);

    if (!match) continue;
    const lineNumber = index + 1;

    if (names.has(match[1])) fail(`duplicate #print axioms command: ${match[1]}`);
    names.add(match[1]);
    expected.set(lineNumber, match[1]);
  }

  return expected;
}

function relativePath(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

// ── TypeScript references ─────────────────────────────────────────────────────
//
// A tsRef names a LIVE SYMBOL: `path#Symbol`, or `path#Owner.member` for a
// requirement that cites a method or a field rather than a top-level function.
// The reference is resolved to an exact declaration in that file, so renaming or
// deleting what a requirement cites fails by name, while moving it inside its
// own file does not.
//
// The earlier grammar was `path:line`, and the only check was
// `line <= fileLineCount`. Every in-range number passed, so a reference could
// point at a blank line, at a doc comment, or at an unrelated statement after any
// edit. And they did: the audit that produced these numbers predates this branch,
// so most rows had already slid onto prose. A line number in a manifest nobody
// re-derives is not a citation.
//
// WHAT THIS DOES NOT CHECK, stated here so nobody reads more into a green gate.
// It holds that a cited declaration EXISTS. It says nothing about what that
// declaration does, so a body rewritten to do the opposite of the requirement's
// statement still resolves, and no theorem here is evidence about the shipped
// code's behaviour. The scanner is also textual: it indexes declarations by
// brace depth rather than by parsing TypeScript, so a same-named local one brace
// deep inside a member-owning declaration can answer for a deleted member, and a
// file TypeScript cannot even PARSE can still satisfy every citation into it.
// That last one is measured rather than assumed: a stray backtick inside a
// comment inside a SQL template ends the literal early, and because the SQL
// carries no braces the depth survives and all four cited members still resolve.
// Deciding parseability is tsc's job and this gate must not be read as doing it.
// A `.js` file is scanned the same way: the device daemon (`packages/pc-agent`) is
// plain JavaScript, and its declarations have the same top-level shapes.
const tsRefPattern =
  /^([A-Za-z0-9_.\-/]+\.(?:ts|js))#([A-Za-z_$][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*))?$/;

const tsTopDeclarationPattern =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|type|enum|const\s+enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

// A member name is followed immediately by `(`, `<`, `:`, `,`, `;` or `}`, or by
// an `=` after optional space. `if (x) {` and `for (const c of cs) {` are the
// shapes that separate a declaration from a statement, and neither has the name
// against its bracket. A keyword list would be wrong here: `delete`, `new`,
// `default` and `in` are all legal member names.
const tsMemberDeclarationPattern =
  /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare)\s+)*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)[?!]?(?:\s*=(?![=>])|(?=[(<:,;}]|$))/;

// Members are addressable under these kinds only. A function body sits at the
// same brace depth as a class body, so without this a local would answer to
// `Owner.member` and outlive the member it was standing in for.
const tsMemberOwnerKinds = new Set(["class", "interface", "type", "enum", "const enum", "const", "let", "var"]);

const regexOpensAfter = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "await", "yield", "throw", "do", "else",
]);

/**
 * One pass over a TypeScript source, producing two line-aligned views: `code`
 * blanks comments and string bodies, which is what brace depth and declaration
 * matching read, and `text` blanks comments only, which is where a mirrored
 * declaration's string literals come from.
 */
function tsScan(source) {
  let code = "";
  let text = "";
  // A `/` opens a regular expression rather than dividing when the code before it
  // cannot end an expression: one of these characters, or one of these keywords.
  // `return /["'{}]/.test(x)` is the shape that makes this load-bearing. Read as
  // division, its quotes open a string and swallow the rest of the file.
  let previous = "\n";
  let word = "";
  let lastWord = "";
  const blank = (char) => (char === "\n" ? "\n" : " ");

  const emit = (into) => {
    code += into;
    text += into;
  };

  const closes = (char) => {
    previous = char;
    word = "";
    lastWord = "";
  };

  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;

      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        emit(blank(source[i]));
        i += 1;
      }

      i += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      emit(char);
      i += 1;

      while (i < source.length && source[i] !== char && source[i] !== "\n") {
        if (source[i] === "\\") {
          code += `${blank(source[i])}${blank(source[i + 1] ?? " ")}`;
          text += source.slice(i, i + 2);
          i += 2;
          continue;
        }

        code += blank(source[i]);
        text += source[i];
        i += 1;
      }

      if (source[i] === char) {
        emit(char);
        i += 1;
      }

      closes(char);
      continue;
    }

    if (char === "`") {
      emit(char);
      i += 1;
      // A template's own text is not a declared set, so it is blanked in both
      // views; the substitution depth is tracked only to find the closing tick.
      let substitution = 0;

      while (i < source.length) {
        if (source[i] === "\\") {
          emit(`${blank(source[i])}${blank(source[i + 1] ?? " ")}`);
          i += 2;
          continue;
        }

        if (substitution === 0 && source[i] === "`") break;

        if (source[i] === "$" && source[i + 1] === "{") {
          substitution += 1;
          emit("  ");
          i += 2;
          continue;
        }

        if (substitution > 0 && source[i] === "}") substitution -= 1;
        emit(blank(source[i]));
        i += 1;
      }

      if (source[i] === "`") {
        emit("`");
        i += 1;
      }

      closes("`");
      continue;
    }

    if (char === "/" && (regexOpensAfter.has(lastWord) || "(,=:[!&|?{};+-*%~^<>\n".includes(previous))) {
      let end = i + 1;
      let inClass = false;
      let closed = false;

      while (end < source.length && source[end] !== "\n") {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }

        if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
        else if (source[end] === "/" && !inClass) {
          closed = true;
          break;
        }

        end += 1;
      }

      if (closed) {
        emit(" ".repeat(end - i + 1));
        i = end + 1;
        closes("/");
        continue;
      }
    }

    emit(char);

    if (/[A-Za-z0-9_$]/.test(char)) word += char;
    else {
      if (word !== "") {
        lastWord = word;
        word = "";
      }

      // Punctuation ends the keyword's reach; whitespace does not.
      if (char.trim() !== "") lastWord = "";
    }

    if (char.trim() !== "") previous = char;
    else if (char === "\n") previous = "\n";
    i += 1;
  }

  return { code, text };
}

/**
 * Every top-level declaration of one file by name, each with the members
 * declared one brace deep inside it. A declaration's `bound` is the last line
 * before the next declaration at the same or an outer depth.
 */
function tsDeclarations(codeLines) {
  const found = [];
  let depth = 0;

  for (const [index, line] of codeLines.entries()) {
    if (depth === 0) {
      const top = tsTopDeclarationPattern.exec(line);

      if (top !== null) {
        const kind = top[1].startsWith("function") ? "function" : top[1].replace(/\s+/g, " ");
        found.push({ name: top[2], kind, line: index + 1, depth, source: line });
      }
    } else if (depth === 1) {
      const member = tsMemberDeclarationPattern.exec(line);

      if (member !== null) {
        found.push({ name: member[1], kind: "member", line: index + 1, depth, source: line });
      }
    }

    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}" && depth > 0) depth -= 1;
    }
  }

  const declarations = new Map();
  let owner;

  for (const [position, entry] of found.entries()) {
    let bound = codeLines.length;

    for (let after = position + 1; after < found.length; after += 1) {
      if (found[after].depth <= entry.depth) {
        bound = found[after].line - 1;
        break;
      }
    }

    if (entry.depth === 0) {
      owner = {
        line: entry.line,
        bound,
        members: new Map(),
        // A value declared as a function is not a member owner however it is spelled.
        ownsMembers: tsMemberOwnerKinds.has(entry.kind) && !/=>|\bfunction\b/.test(entry.source),
      };

      if (!declarations.has(entry.name)) declarations.set(entry.name, owner);
    } else if (owner !== undefined && owner.ownsMembers && !owner.members.has(entry.name)) {
      owner.members.set(entry.name, { line: entry.line, bound });
    }
  }

  return declarations;
}

const tsFiles = new Map();

function tsFile(path) {
  let file = tsFiles.get(path);

  if (file === undefined) {
    const scanned = tsScan(readFileSync(path, "utf8"));
    const code = scanned.code.split("\n");
    file = { code, text: scanned.text.split("\n"), declarations: tsDeclarations(code) };
    tsFiles.set(path, file);
  }

  return file;
}

/** The declaration a reference names, or the reason it names none. */
function resolveTsRef(reference) {
  const match = tsRefPattern.exec(reference);

  if (match === null) return { error: "is not a `path#Symbol` or `path#Owner.member` reference" };
  const [, relative, symbol, member] = match;
  const path = resolve(repoRoot, relative);

  if (!path.startsWith(`${repoRoot}/`)) return { error: "escapes the repository root" };
  let file;

  try {
    file = tsFile(path);
  } catch (error) {
    // A read that fails carries an errno; anything else is this scanner's own
    // bug and must not read as a missing file.
    if (error.code === undefined) throw error;

    return { error: "names a file that does not exist" };
  }

  const declaration = file.declarations.get(symbol);

  if (declaration === undefined) return { error: `names \`${symbol}\`, which ${relative} does not declare` };

  if (member === undefined) return { file, span: declaration };
  const owned = declaration.members.get(member);

  if (owned === undefined) return { error: `names \`${member}\`, which \`${symbol}\` does not declare` };

  return { file, span: owned };
}

/** The single-quoted literals one declaration lists, up to its first blank line. */
function tsStringLiterals(file, span) {
  const values = [];

  for (let line = span.line; line <= span.bound; line += 1) {
    if (line > span.line && file.code[line - 1].trim() === "") break;

    for (const match of file.text[line - 1].matchAll(/'([^']+)'/g)) values.push(match[1]);
  }

  return values;
}

/**
 * Why a refinement entry does not bridge, or undefined when it does: the fixture
 * is a generated case list naming itself, and the test exists and reads that
 * fixture. Whether the test ASSERTS anything about it is the test's own review.
 */
function refinementProblem(fixture, name, test) {
  let parsed;

  try {
    parsed = JSON.parse(readFileSync(resolve(repoRoot, fixture), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "the fixture does not exist";

    if (error instanceof SyntaxError) return `the fixture is not JSON: ${error.message}`;
    throw error;
  }

  if (parsed?.fixture !== name) return `the fixture names itself ${JSON.stringify(parsed?.fixture)}, not ${name}`;

  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) return "the fixture holds no case";
  let source;

  try {
    source = readFileSync(resolve(repoRoot, test), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "the test does not exist";
    throw error;
  }

  if (!source.includes(fixture)) return `the test never reads ${fixture}`;

  return undefined;
}

function fixtureNames() {
  try {
    return readdirSync(fixtureRoot);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const refinementFixtures = new Set();

const refinementTests = new Set();

const requirements = parseTraceability(readFileSync(traceabilityPath, "utf8"));

if (requirements.size === 0) fail("traceability.yaml contains no requirements");

const theoremOwners = new Map();

const axiomOwners = new Map();

const citedSymbols = new Set();

for (const requirement of requirements.values()) {
  for (const field of ["statement", "status", "theorems", "tsRefs", "remainingEvidence"]) {
    if (!requirement.fields.has(field)) fail(`${requirement.id}: missing required field ${field}`);
  }

  if (!/[.!?]$/.test(requirement.statement ?? "")) {
    fail(`${requirement.id}: statement must be one sentence ending in punctuation`);
  }

  if (!allowedStatuses.has(requirement.status)) {
    fail(`${requirement.id}: invalid status ${requirement.status ?? "(missing)"}`);
  }

  if (requirement.tsRefs.length === 0) fail(`${requirement.id}: tsRefs must not be empty`);

  if (requirement.remainingEvidence.length === 0) {
    fail(`${requirement.id}: remainingEvidence must not be empty`);
  }

  if (requirement.status === "specified-not-modeled" &&
      (requirement.theorems.length !== 0 || requirement.axioms.length !== 0)) {
    fail(`${requirement.id}: specified-not-modeled requirements cannot claim Lean declarations`);
  }

  if (requirement.status === "trusted-model-assumption" && requirement.axioms.length === 0) {
    fail(`${requirement.id}: trusted-model-assumption must enumerate at least one axiom`);
  }

  if (["proved-and-refined", "proved-in-abstract-model", "by-construction-witness"].includes(requirement.status) &&
      requirement.theorems.length === 0) {
    fail(`${requirement.id}: ${requirement.status} must claim at least one theorem`);
  }

  if ((requirement.status === "proved-and-refined") !== (requirement.refinement.length > 0)) {
    fail(`${requirement.id}: a refinement list belongs to proved-and-refined and to nothing else`);
  }

  if (requirement.status !== "trusted-model-assumption" && requirement.axioms.length > 0) {
    fail(`${requirement.id}: only trusted-model-assumption may enumerate axioms`);
  }

  for (const name of requirement.theorems) {
    if (!qualifiedNamePattern.test(name)) fail(`${requirement.id}: invalid theorem name ${name}`);

    if (theoremOwners.has(name)) {
      fail(`theorem claimed more than once: ${name} (${theoremOwners.get(name)}, ${requirement.id})`);
    } else theoremOwners.set(name, requirement.id);
  }

  for (const name of requirement.axioms) {
    if (!qualifiedNamePattern.test(name)) fail(`${requirement.id}: invalid axiom name ${name}`);

    if (axiomOwners.has(name)) {
      fail(`axiom claimed more than once: ${name} (${axiomOwners.get(name)}, ${requirement.id})`);
    } else axiomOwners.set(name, requirement.id);
  }

  const ownRefs = new Set();

  for (const ref of requirement.tsRefs) {
    if (ownRefs.has(ref)) {
      fail(`${requirement.id}: tsRef is cited twice: ${ref}`);
      continue;
    }

    ownRefs.add(ref);
    citedSymbols.add(ref);
    const resolved = resolveTsRef(ref);

    if (resolved.error !== undefined) fail(`${requirement.id}: tsRef ${ref} ${resolved.error}`);
  }

  for (const entry of requirement.refinement) {
    const match = refinementPattern.exec(entry);

    if (match === null) {
      fail(`${requirement.id}: refinement ${entry} is not \`lean/fixtures/<name>.json :: packages/<pkg>/tests/<file>.test.ts\` (or .test.js)`);
      continue;
    }

    const [, fixture, name, test] = match;
    refinementFixtures.add(fixture);
    refinementTests.add(test);
    const problem = refinementProblem(fixture, name, test);

    if (problem !== undefined) fail(`${requirement.id}: refinement ${entry}: ${problem}`);
  }
}

// A fixture no requirement claims is a bridge nothing relies on: either its
// requirement lost the entry, or the fixture outlived its model.
for (const entry of fixtureNames()) {
  if (!refinementFixtures.has(`lean/fixtures/${entry}`)) {
    fail(`lean/fixtures/${entry} is claimed by no requirement's refinement list`);
  }
}


// `scripts/verify-lean.sh` runs exactly the tests the manifest names, one line each.
if (process.argv.includes("--list-refinement-tests")) {
  exitOnFailures();
  process.stdout.write([...refinementTests].map((test) => `${test}\n`).join(""));
  process.exit(0);
}

const declarations = collectDeclarations(walkLeanSources(leanRoot));

const expectedReports = collectExpectedAxiomReports(readFileSync(axiomAuditPath, "utf8"));

for (const name of theoremOwners.keys()) {
  if (!declarations.theorems.has(name)) fail(`claimed theorem not found by exact source declaration: ${name}`);
}

for (const name of axiomOwners.keys()) {
  if (!declarations.axioms.has(name)) fail(`claimed axiom not found by exact source declaration: ${name}`);
}

for (const name of declarations.axioms) {
  if (!axiomOwners.has(name)) fail(`source axiom is not enrolled as a trusted model assumption: ${name}`);
}

// A Lean inductive that claims to mirror an implementation's state set, and
// nothing checking it, reads as verified and is only asserted. Constructors are
// identifiers and the shipped values are string literals, so the comparison is a
// set equality over names folded to letters (`bestFirst` <-> `best-first`).
// Enrolled rather than discovered: a mirror nobody declared cannot be checked, so
// adding one is a reviewable edit. None yet: the modeled state sets
// (`vfs_contents.state`) ship as integers, not string literals.
const STATE_MIRRORS = [];

function auditStateMirrors(inductives) {
  const fold = (value) => value.replaceAll(/[-_]/g, "").toLowerCase();

  for (const { lean, ts } of STATE_MIRRORS) {
    const inductive = inductives.get(lean);

    if (inductive === undefined) {
      fail(`state mirror: no Lean inductive is declared as ${lean}`);
      continue;
    }

    const resolved = resolveTsRef(ts);

    if (resolved.error !== undefined) {
      fail(`state mirror ${lean}: ${ts} ${resolved.error}`);
      continue;
    }

    const values = tsStringLiterals(resolved.file, resolved.span);

    if (values.length === 0) {
      fail(`state mirror ${lean}: ${ts} lists no string literal, so the comparison would pass on nothing`);
      continue;
    }

    const modelled = new Set(inductive.constructors.map(fold));
    const shipped = new Set(values.map(fold));

    if (modelled.size !== inductive.constructors.length || shipped.size !== values.length) {
      fail(`state mirror ${lean}: two names fold to one, so a difference between the sets could hide`);
      continue;
    }

    const extra = inductive.constructors.filter((c) => !shipped.has(fold(c)));
    const missing = values.filter((v) => !modelled.has(fold(v)));

    if (extra.length > 0) {
      fail(`state mirror ${lean}: models ${extra.join(", ")}, which ${ts} does not ship`);
    }

    if (missing.length > 0) {
      fail(`state mirror ${lean}: ${ts} ships ${missing.join(", ")}, which the model omits`);
    }
  }
}

auditStateMirrors(declarations.inductives);

// Every theorem with the file that declares it, one per line.
if (process.argv.includes("--list-declarations")) {
  exitOnFailures();
  const lines = [];

  for (const path of walkLeanSources(leanRoot)) {
    for (const name of collectDeclarations([path]).theorems) {
      lines.push(`${name}\t${relativePath(path)}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

if (manifestOnly) {
  exitOnFailures();
  console.log(
    `check-traceability: manifest OK — ${requirements.size} requirements, ` +
    `${citedSymbols.size} cited TypeScript declarations, ${STATE_MIRRORS.length} state mirrors, ` +
    `${theoremOwners.size} claimed theorems, ${refinementFixtures.size} refinement fixtures ` +
    "(kernel axiom audit skipped: --manifest-only)",
  );
  process.exit(0);
}

const build = spawnSync(process.env.LAKE ?? "lake", ["build", "Nimbus.Axioms"], {
  cwd: leanRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (build.error && build.status === null) {
  console.error(`check-traceability: failed to start lake: ${build.error.message}`);
  process.exit(1);
}

if (build.status !== 0) {
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  console.error("check-traceability: lake build Nimbus.Axioms failed");
  process.exit(1);
}

const buildOutput = `${build.stdout}\n${build.stderr}`;

const reported = new Map();

const reportPattern = /^info: .*Nimbus\/Axioms\.lean:(\d+):\d+: '(Nimbus\.[^']+)' (does not depend on any axioms|depends on axioms: \[([^\]]*)\])\s*$/gm;

for (const match of buildOutput.matchAll(reportPattern)) {
  const lineNumber = Number(match[1]);
  const name = match[2];
  const expectedName = expectedReports.get(lineNumber);

  if (expectedName !== name) {
    fail(`axiom report is not backed by a matching #print axioms command at line ${lineNumber}: ${name}`);
    continue;
  }

  const axioms = match[4]?.trim()
    ? match[4].split(",").map((axiom) => axiom.trim())
    : [];

  if (reported.has(name)) fail(`duplicate theorem in axiom report: ${name}`);
  reported.set(name, axioms);
}

if (reported.size === 0) {
  console.error(buildOutput);
  console.error("check-traceability: no #print axioms records captured from Nimbus.Axioms");
  process.exit(1);
}

for (const [name, axioms] of reported) {
  const ownerId = theoremOwners.get(name);

  if (!ownerId) fail(`theorem in axiom report is unclaimed: ${name}`);

  if (!declarations.theorems.has(name)) fail(`reported theorem has no exact source declaration: ${name}`);

  for (const axiom of axioms) {
    if (axiom.includes("sorryAx")) {
      fail(`theorem depends on forbidden proof placeholder ${axiom}: ${name}`);
      continue;
    }

    if (allowedKernelAxioms.has(axiom)) continue;
    const owner = ownerId ? requirements.get(ownerId) : undefined;

    if (owner?.status !== "trusted-model-assumption" || !owner.axioms.includes(axiom)) {
      fail(`theorem depends on undocumented non-kernel axiom ${axiom}: ${name}`);
    }
  }
}

for (const name of theoremOwners.keys()) {
  if (!reported.has(name)) fail(`claimed theorem missing from Nimbus.Axioms report: ${name}`);
}

for (const name of declarations.theorems) {
  if (![...expectedReports.values()].includes(name)) {
    fail(`published source theorem has no #print axioms command: ${name}`);
  }

  if (!reported.has(name)) fail(`published source theorem missing from Nimbus.Axioms audit: ${name}`);
}

for (const name of expectedReports.values()) {
  if (!declarations.theorems.has(name)) fail(`#print axioms target has no source theorem declaration: ${name}`);

  if (!reported.has(name)) fail(`#print axioms command produced no matching audit record: ${name}`);
}

exitOnFailures();

const statusCounts = new Map();

for (const requirement of requirements.values()) {
  statusCounts.set(requirement.status, (statusCounts.get(requirement.status) ?? 0) + 1);
}

const statusSummary = [...statusCounts].map(([status, count]) => `${status}=${count}`).join(", ");

console.log(
  `check-traceability: OK — ${requirements.size} requirements, ${reported.size} theorems, ` +
  `${declarations.axioms.size} trusted axiom, ${refinementFixtures.size} refinement fixtures ` +
  `(${statusSummary})`,
);
