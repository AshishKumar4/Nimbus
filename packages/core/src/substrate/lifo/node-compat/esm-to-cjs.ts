/**
 * ES module syntax lowered to the CommonJS the lifo node's module wrapper
 * runs: imports become requires, exports assignments to `exports`, and
 * import.meta the wrapper's __importMeta parameters.
 */

// Names that collide with the new Function() CJS wrapper parameters.
// Using `const` for these would throw "Identifier X has already been declared",
// so we emit `var` instead (var can shadow function params in non-strict mode).
const CJS_WRAPPER_PARAMS = new Set([
	'exports', 'require', 'module', '__filename', '__dirname',
	'console', 'process', 'Buffer', 'setTimeout', 'setInterval',
	'clearTimeout', 'clearInterval', 'global',
	'__importMetaUrl', '__importMeta', '__importMetaResolve',
]);
function cjsDecl(name: string): string {
	return CJS_WRAPPER_PARAMS.has(name) ? 'var' : 'const';
}

/**
 * Mask string/template literals with safe placeholders so that
 * import/export regexes don't match keywords inside string content.
 * Returns the masked source and an array of original literals for restoration.
 */
function maskStringLiterals(src: string): { masked: string; literals: string[] } {
	const literals: string[] = [];
	let masked = '';
	let i = 0;

	while (i < src.length) {
		const ch = src[i];

		// Skip single-line comments (may contain unmatched quotes)
		if (ch === '/' && i + 1 < src.length && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i);
			const end = nl === -1 ? src.length : nl;
			masked += src.slice(i, end);
			i = end;
			continue;
		}
		// Skip multi-line comments
		if (ch === '/' && i + 1 < src.length && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			const close = end === -1 ? src.length : end + 2;
			masked += src.slice(i, close);
			i = close;
			continue;
		}

		// Regex literals — skip to avoid confusing backticks inside /regex/ with templates
		if (ch === '/' && i + 1 < src.length && src[i + 1] !== '/' && src[i + 1] !== '*') {
			// Heuristic: '/' is a regex if preceded by an operator, keyword, or start-of-line.
			// IMPORTANT: We include ')' and '}' even though they can precede division too,
			// because under-detection is catastrophic: a backtick inside an undetected
			// regex triggers the template-literal parser which can eat the rest of the file.
			// Over-detection is harmless: the regex scanner copies content as-is and stops
			// at newline, so the output is identical either way.
			let k = i - 1;
			while (k >= 0 && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k--;
			const prev = k >= 0 ? src[k] : '\0';
			if ('\0=([{,;!&|^~?:+-*%<>/)]}'.includes(prev) ||
				(k >= 1 && /\b(?:return|typeof|void|delete|throw|new|case|of|in|yield|await)\s*$/.test(src.slice(Math.max(0, k - 11), k + 1)))) {
				const regStart = i;
				i++; // skip opening /
				while (i < src.length && src[i] !== '\n') {
					if (src[i] === '\\') { i += 2; continue; }
					if (src[i] === '/') { i++; break; }
					if (src[i] === '[') { // character class — / doesn't end regex inside [...]
						i++;
						while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
							if (src[i] === '\\') i++;
							i++;
						}
						if (i < src.length && src[i] === ']') i++;
						continue;
					}
					i++;
				}
				while (i < src.length && /[gimsuyv]/.test(src[i])) i++; // flags
				masked += src.slice(regStart, i);
				continue;
			}
		}

		// String/template literals
		if (ch === '"' || ch === "'" || ch === '`') {
			const start = i;
			const quote = ch;
			i++; // skip opening quote
			while (i < src.length) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === quote) { i++; break; }
				// Template literal ${...} expressions — skip with depth tracking
				if (quote === '`' && src[i] === '$' && i + 1 < src.length && src[i + 1] === '{') {
					let depth = 1;
					i += 2;
					while (i < src.length && depth > 0) {
						if (src[i] === '{') depth++;
						else if (src[i] === '}') depth--;
						else if (src[i] === '\\') i++;
						else if (src[i] === "'" || src[i] === '"') {
							const q = src[i]; i++;
							while (i < src.length && src[i] !== q) {
								if (src[i] === '\\') i++;
								i++;
							}
							if (i < src.length) i++; // skip closing quote
							continue;
						} else if (src[i] === '`') {
							// Nested template literal inside expression
							i++;
							while (i < src.length && src[i] !== '`') {
								if (src[i] === '\\') i++;
								i++;
							}
							if (i < src.length) i++;
							continue;
						}
						i++;
					}
					continue;
				}
				i++;
			}

			const literal = src.slice(start, i);
			const idx = literals.length;
			literals.push(literal);

			// Placeholder uses same quote style so import regexes that capture
			// ['"][^'"]+['"] still work (they see e.g. "__LIFO_S0__").
			masked += quote + '__LIFO_S' + idx + '__' + quote;
			continue;
		}

		masked += ch;
		i++;
	}

	return { masked, literals };
}

/**
 * Restore original string/template literals from masked placeholders.
 */
function unmaskStringLiterals(src: string, literals: string[]): string {
	return src.replace(
		/(['"`])__LIFO_S(\d+)__\1/g,
		(_match, _quote, idxStr) => literals[parseInt(idxStr, 10)]
	);
}

/** Transform ESM import/export syntax to CJS require/exports equivalents */
export function transformEsmToCjs(source: string): string {
	// Normalize \r\n → \n so regexes anchored on \n work with Windows line endings
	let result = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// import.meta.* replacements MUST run before masking.
	// The masker may incorrectly consume code regions (e.g. regex literals with
	// backticks), so import.meta must be replaced on the raw source first.
	// These are safe on raw source: replacements are plain identifiers that won't
	// cause issues even if they accidentally match inside string literals.
	result = result.split('import.meta.url').join('__importMetaUrl');
	result = result.split('import.meta.dirname').join('__dirname');
	result = result.split('import.meta.filename').join('__filename');
	result = result.split('import.meta.require').join('require');
	result = result.split('import.meta.resolve').join('__importMetaResolve');
	// Bare import.meta (catch-all, must come AFTER specific property replacements)
	result = result.split('import.meta').join('__importMeta');

	// Mask string/template literal contents so import/export regexes don't
	// match keywords inside strings (e.g. const HELPERS = `export function ...`)
	const { masked, literals } = maskStringLiterals(result);

	result = masked;
	// Split semicolon-separated import/export onto their own lines
	// so that the (?:^|\n) anchored regexes below can find them in minified code
	result = result.replace(
		/;([ \t]*(?:import\s*[\w${*('".]|export[\s{*]))/g,
		';\n$1'
	);
	const trailingExports: string[] = [];
	let hasDefaultExport = false;
	let hasNamedExport = false;
	// Track import sources: localName → { modRef, prop } for live-binding exports
	const importSources = new Map<string, { modRef: string; prop: string }>();

	// Scan for export types to decide default export strategy
	hasDefaultExport = /(?:^|\n)\s*export\s+default\s+/.test(result);
	hasNamedExport = /(?:^|\n)\s*export\s+(?:const|let|var|function|class|\{|\*\s+from)/.test(result);

	// --- Import transforms ---
	// NOTE: JS identifiers can contain $ (e.g. fs$8, path$b in esbuild bundles).
	// We use [\w$]+ instead of \w+ throughout to match these correctly.

	// Combined: import X, { a, b as c } from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, defaultName, imports, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (imports.includes('${')) return match;
			const tmp = '__mod_' + defaultName;
			const mapped = imports.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const sourceProp = parts[0].trim();
				const localName = parts.length === 2 ? parts[1].trim() : sourceProp;
				if (localName) importSources.set(localName, { modRef: tmp, prop: sourceProp });
				if (parts.length === 2) return `${sourceProp}: ${localName}`;
				return sourceProp;
			}).filter((s: string) => s).join(', ');
			return `\n${indent}${cjsDecl(tmp)} ${tmp} = require(${mod});\n${indent}${cjsDecl(defaultName)} ${defaultName} = ${tmp}.default || ${tmp};\n${indent}const { ${mapped} } = ${tmp};`;
		}
	);

	// Combined: import X, * as Y from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s*,\s*\*\s*as\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, defaultName, nsName, mod) => {
			return `\n${indent}${cjsDecl(nsName)} ${nsName} = require(${mod});\n${indent}${cjsDecl(defaultName)} ${defaultName} = ${nsName}.default || ${nsName};`;
		}
	);

	// import { a, b as c } from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, imports, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (imports.includes('${')) return match;
			const modRef = '__imp_' + Math.random().toString(36).slice(2, 8);
			const mapped = imports.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const sourceProp = parts[0].trim();
				const localName = parts.length === 2 ? parts[1].trim() : sourceProp;
				if (localName) importSources.set(localName, { modRef, prop: sourceProp });
				if (parts.length === 2) return `${sourceProp}: ${localName}`;
				return sourceProp;
			}).filter((s: string) => s).join(', ');
			return `\n${indent}const ${modRef} = require(${mod});\n${indent}const { ${mapped} } = ${modRef};`;
		}
	);

	// import * as X from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*\*\s*as\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, name, mod) => `\n${indent}${cjsDecl(name)} ${name} = require(${mod});`
	);

	// import X from 'mod' (default import)
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, name, mod) => `\n${indent}${cjsDecl(name)} ${name} = require(${mod});`
	);

	// import 'mod' (side-effect)
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, mod) => `\n${indent}require(${mod});`
	);

	// --- Export transforms ---

	// Strip empty export{} (bundler ESM marker, no-op)
	result = result.replace(/(?:^|\n)[ \t]*export\s*\{\s*\}[ \t]*;?/g, '');

	// export * from 'mod' — use getter-based forwarding for live bindings
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\*\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, mod) => {
			const tmpVar = '__star_' + Math.random().toString(36).slice(2, 8);
			return `\n${indent}const ${tmpVar} = require(${mod});\n${indent}Object.keys(${tmpVar}).forEach(function(k) { if (k !== 'default' && !exports.hasOwnProperty(k)) Object.defineProperty(exports, k, { get: function() { return ${tmpVar}[k]; }, enumerable: true, configurable: true }); });`;
		}
	);

	// export { a, b } from 'mod' (re-export) — use getters for live bindings
	// (handles circular dependencies where source module isn't fully populated yet)
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, names, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (names.includes('${')) return match;
			const tmpVar = '__re_' + Math.random().toString(36).slice(2, 8);
			const assignments = names.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const local = parts[0].trim();
				const exported = parts.length === 2 ? parts[1].trim() : local;
				return `${indent}Object.defineProperty(exports, '${exported}', { get() { return ${tmpVar}.${local}; }, enumerable: true, configurable: true });`;
			}).join('\n');
			return `\n${indent}const ${tmpVar} = require(${mod});\n${assignments}`;
		}
	);

	// export default <expr> — must come before named export { }
	if (hasDefaultExport && hasNamedExport) {
		result = result.replace(
			/(?:^|\n)([ \t]*)export\s+default\s+/g,
			(_match, indent) => `\n${indent}exports.default = `
		);
	} else {
		result = result.replace(
			/(?:^|\n)([ \t]*)export\s+default\s+/g,
			(_match, indent) => `\n${indent}module.exports = `
		);
	}

	// export const/let/var x = ...
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s+(const|let|var)\s+([\w$]+)\s*=/g,
		(match, indent, keyword, name) => {
			// Guard: ${ means regex matched inside a template literal
			if (match.includes('${')) return match;
			return `\n${indent}${keyword} ${name} = exports.${name} =`;
		}
	);

	// export function f(...) / export async function f(...) / export class C
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s+(async\s+function\s+([\w$]+)|function\s+([\w$]+)|class\s+([\w$]+))/g,
		(match, indent, decl, asyncFnName, fnName, className, offset: number) => {
			// Guard: if char after match is '{', it's a template literal `export function ${fn}`
			// Real exports have '(' after function name or '{' after class + whitespace
			const nextChar = result.charAt(offset + match.length);
			if (nextChar === '{') return match;
			const name = asyncFnName || fnName || className;
			trailingExports.push(`exports.${name} = ${name};`);
			return `\n${indent}${decl}`;
		}
	);

	// export { a, b as c } (local exports, no from)
	// Use trailing exports to ensure declarations are fully initialized.
	// For names that were imported from another module, use getters pointing
	// back to the source module reference — this creates ESM-like live bindings
	// that survive circular dependencies.
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\{([^}]+)\}[ \t]*;?/g,
		(match, _indent, names) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (names.includes('${')) return match;
			names.split(',').forEach((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const local = parts[0].trim();
				const exported = parts.length === 2 ? parts[1].trim() : local;
				if (!local) return;
				const src = importSources.get(local);
				if (src) {
					// Imported name → lazy getter reading from source module reference
					trailingExports.push(`Object.defineProperty(exports, '${exported}', { get: function() { return ${src.modRef}.${src.prop}; }, enumerable: true, configurable: true });`);
				} else {
					// Locally defined → direct assignment at end of file
					trailingExports.push(`exports.${exported} = ${local};`);
				}
			});
			return '';
		}
	);

	// --- Other transforms ---

	// Dynamic import() with string literal → Promise.resolve(require())
	// Negative lookbehind: skip obj.import('...') where '.' precedes import
	result = result.replace(
		/(?<!\.)(?<!\w)\bimport\s*\(\s*(['"][^'"]+['"])\s*\)/g,
		(_match, mod) => `Promise.resolve(require(${mod}))`
	);

	// Dynamic import() with any expression (variables, template literals, nested parens, etc.)
	// Must come AFTER the string-literal version above.
	// Use programmatic paren-balancing since regex can't handle nested parens.
	{
		let i = 0;
		let out = '';
		while (i < result.length) {
			// Look for `import(`
			const importIdx = result.indexOf('import(', i);
			if (importIdx === -1) { out += result.slice(i); break; }
			// Check word boundary: char before 'import' must not be [\w$.] (dot = method call)
			if (importIdx > 0 && /[\w$.]/.test(result[importIdx - 1])) {
				out += result.slice(i, importIdx + 7);
				i = importIdx + 7;
				continue;
			}
			// Skip class/object method definitions like `async import(url) {` or `import(url) {`
			// Method definitions have `) {` after the parameter list (opening method body).
			// Dynamic imports NEVER have `{` directly after `)`.
			{
				let depth = 1;
				let k = importIdx + 7;
				while (k < result.length && depth > 0) {
					if (result[k] === '(') depth++;
					else if (result[k] === ')') depth--;
					k++;
				}
				if (depth === 0) {
					let afterClose = k;
					while (afterClose < result.length && /[ \t]/.test(result[afterClose])) afterClose++;
					if (result[afterClose] === '{') {
						// This is a method/function definition, not a dynamic import — skip
						out += result.slice(i, importIdx + 7);
						i = importIdx + 7;
						continue;
					}
				}
			}
			out += result.slice(i, importIdx);
			// Find matching close paren with depth tracking
			let depth = 1;
			let j = importIdx + 7; // after 'import('
			while (j < result.length && depth > 0) {
				if (result[j] === '(') depth++;
				else if (result[j] === ')') depth--;
				j++;
			}
			if (depth === 0) {
				const arg = result.slice(importIdx + 7, j - 1);
				out += `Promise.resolve().then(function() { return require(${arg}); })`;
			} else {
				// Unbalanced — leave as-is
				out += result.slice(importIdx, j);
			}
			i = j;
		}
		result = out;
	}

	// --- Final fixups ---

	// Replace const/let declarations of CJS wrapper param names with var.
	// esbuild bundles often emit `const __dirname = ...` which collides with
	// the new Function() wrapper parameters. `var` can shadow them safely.
	result = result.replace(
		/\b(const|let)\s+(__dirname|__filename|exports|require|module|console|process|Buffer|global)\b/g,
		(_match, _kw, name) => `var ${name}`
	);

	// Append trailing exports for exported functions/classes
	if (trailingExports.length > 0) {
		result += '\n' + trailingExports.join('\n');
	}

	// Restore original string/template literal contents
	result = unmaskStringLiterals(result, literals);

	return result;
}

