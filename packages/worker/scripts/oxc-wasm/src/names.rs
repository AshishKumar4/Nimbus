//! Names for the bindings module conversion introduces, chosen as esbuild
//! chooses them: `import_<file>` from the import's path, `stdin_exports` and
//! `stdin_default`, the helpers' own names. A generated name keeps its
//! spelling; a user symbol that would collide with it is renamed (`require`
//! becomes `require2`), and a generated name that is an unbound global in the
//! module takes the next free suffix instead, since a global cannot be renamed.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashSet, FxHasher};

use oxc::allocator::Allocator;
use oxc::semantic::{Scoping, SymbolId};
use oxc::str::Ident;
use oxc::syntax::keyword::is_reserved_keyword;

/// esbuild's `GenerateNonUniqueNameFromPath`: the file name without its
/// extension, or the directory's name for an `index` file, as an identifier.
pub fn name_from_path(path: &str) -> String {
    let (dir, base) = split_dir_base(path);
    let mut base = strip_ext(base);
    if base == "index" {
        let dir_base = strip_ext(split_dir_base(dir).1);
        if !dir_base.is_empty() {
            base = dir_base;
        }
    }
    ensure_valid_identifier(base)
}

fn split_dir_base(path: &str) -> (&str, &str) {
    match path.rfind(['/', '\\']) {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

fn strip_ext(base: &str) -> &str {
    match base.rfind('.') {
        Some(i) => &base[..i],
        None => base,
    }
}

/// esbuild's `EnsureValidIdentifier`: ASCII letters and digits, runs of
/// anything else collapsed to one `_`, no leading digit, never empty.
pub fn ensure_valid_identifier(base: &str) -> String {
    let mut out = String::with_capacity(base.len());
    let mut needs_gap = false;
    for c in base.chars() {
        if c.is_ascii_alphabetic() || (!out.is_empty() && c.is_ascii_digit()) {
            if needs_gap {
                out.push('_');
                needs_gap = false;
            }
            out.push(c);
        } else if !out.is_empty() {
            needs_gap = true;
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Globals the generated code reads (the helpers' names are reserved as they
/// are used). A generated binding never takes one of these names.
const READ_BY_OUTPUT: [&str; 5] = ["Object", "Promise", "require", "module", "exports"];

/// The module's names, and the renames that keep generated names free.
///
/// What is in use is kept as hashes: a module of a hundred thousand symbols
/// would otherwise copy every name. A hash that collides only makes a free
/// name look taken, which costs a suffix or a rename, never a clash.
pub struct Names {
    /// Every name in use: symbols (any scope), unbound globals, generated names.
    taken: FxHashSet<u64>,
    unresolved: FxHashSet<String>,
    generated: FxHashSet<String>,
}

fn hash(name: &str) -> u64 {
    let mut hasher = FxHasher::default();
    name.hash(&mut hasher);
    hasher.finish()
}

impl Names {
    pub fn new(scoping: &Scoping) -> Self {
        let mut taken: FxHashSet<u64> = scoping.symbol_names().map(hash).collect();
        let unresolved: FxHashSet<String> =
            scoping.root_unresolved_references().keys().map(|k| k.to_string()).collect();
        taken.extend(unresolved.iter().map(|n| hash(n)));
        Self { taken, unresolved, generated: FxHashSet::default() }
    }

    /// Claim `name` for a generated binding and return the spelling to use.
    pub fn generate(&mut self, name: &str, scoping: &mut Scoping, allocator: &Allocator) -> String {
        // `export * as default from "x"` names its record after a reserved
        // word, `export * as Object from "x"` after a global the output reads:
        // `default2`, `Object2`.
        let name = if self.unresolved.contains(name)
            || self.generated.contains(name)
            || is_reserved_keyword(name)
            || READ_BY_OUTPUT.contains(&name)
        {
            self.fresh(name)
        } else {
            self.evict(name, scoping, allocator);
            name.to_string()
        };
        self.taken.insert(hash(&name));
        self.generated.insert(name.clone());
        name
    }

    /// Generated code refers to the global (or wrapper parameter) `name`:
    /// rename every symbol that would shadow it.
    pub fn reserve_global(&mut self, name: &str, scoping: &mut Scoping, allocator: &Allocator) {
        if self.generated.insert(name.to_string()) {
            self.evict(name, scoping, allocator);
        }
    }

    fn evict(&mut self, name: &str, scoping: &mut Scoping, allocator: &Allocator) {
        if !self.taken.contains(&hash(name)) {
            return;
        }
        let symbols: Vec<SymbolId> = scoping.symbol_ids().filter(|&s| scoping.symbol_name(s) == name).collect();
        if symbols.is_empty() {
            return;
        }
        let renamed = self.fresh(name);
        self.taken.insert(hash(&renamed));
        let ident = Ident::from_str_in(&renamed, &allocator);
        for symbol in symbols {
            scoping.set_symbol_name(symbol, ident);
        }
    }

    /// A name no symbol of the module has, for a binding only generated code
    /// sees (a wrapper's parameter): `name` itself, or `name2`, ….
    pub fn claim_fresh(&mut self, name: &str) -> String {
        let name = if self.taken.contains(&hash(name)) { self.fresh(name) } else { name.to_string() };
        self.taken.insert(hash(&name));
        self.generated.insert(name.clone());
        name
    }

    /// `name2`, `name3`, … : the first not in use.
    fn fresh(&self, name: &str) -> String {
        (2u32..)
            .map(|n| format!("{name}{n}"))
            .find(|candidate| !self.taken.contains(&hash(candidate)))
            .expect("an unused name")
    }
}

#[cfg(test)]
mod tests {
    use super::name_from_path;

    #[test]
    fn names_follow_esbuild() {
        assert_eq!(name_from_path("@scope/pkg"), "pkg");
        assert_eq!(name_from_path("node:fs"), "node_fs");
        assert_eq!(name_from_path("./foo/bar-baz.js"), "bar_baz");
        assert_eq!(name_from_path("../x/index.mjs"), "x");
        assert_eq!(name_from_path("lodash.get"), "lodash");
        assert_eq!(name_from_path("1abc"), "abc");
        assert_eq!(name_from_path("."), "_");
        assert_eq!(name_from_path("a"), "a");
    }
}
