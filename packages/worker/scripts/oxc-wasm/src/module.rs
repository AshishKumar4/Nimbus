//! Module format conversion, after TypeScript, JSX and defines have run.
//!
//! `Format::Cjs` lowers ES module syntax to CommonJS the way esbuild 0.24's
//! transform API does, because that is the shape the rest of Nimbus was
//! written against (bundle-cell-transform.ts, server-launch.ts):
//!
//! ```js
//! // helpers (helpers.rs), only those used
//! var stdin_exports = {};                      // a module with export syntax
//! __export(stdin_exports, { a: () => a, default: () => stdin_default });
//! module.exports = __toCommonJS(stdin_exports); // marks __esModule
//! var import_x = __toESM(require("x"));        // every import, hoisted in order
//! __reExport(stdin_exports, require("y"), module.exports);
//! ...body, with each use of an imported binding read through its record
//! (`(0, import_x.f)()` for a call, so `this` stays undefined)
//! ```
//!
//! Live bindings come from the getters; `default` imports go through
//! `__toESM`, whose `__esModule` rule is Babel's (esbuild's), not Node's.
//! Every format also does what esbuild does to `import.meta` and `import()`
//! when the target lacks them, and replaces top-level `this` in an ES module
//! with `void 0`. `Format::Esm` wraps a CommonJS module (one that uses
//! `module`/`exports` and has no export syntax) as `__commonJS` and exports
//! its `module.exports` as `default`.

use rustc_hash::FxHashMap;

use oxc::allocator::{Allocator, Box as ArenaBox, GetAllocator, TakeIn, Vec as ArenaVec};
use oxc::ast::builder::AstBuilder;
use oxc::ast::ast::*;
use oxc::ast_visit::VisitMut;
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::Parser;
use oxc::semantic::{Scoping, SymbolId};
use oxc::span::{SPAN, SourceType, Span};
use oxc::str::Ident;
use oxc::syntax::identifier::is_identifier_name;
use oxc::syntax::number::NumberBase;
use oxc::syntax::operator::UnaryOperator;
use oxc_ecmascript::BoundNames;
use oxc_traverse::{Ancestor, Traverse, traverse_mut};

use crate::helpers::{Helper, Helpers};
use crate::names::{Names, ensure_valid_identifier, name_from_path};
use crate::options::Format;

type TraverseCtx<'a> = oxc_traverse::TraverseCtx<'a, ()>;

pub struct ModuleOptions {
    pub format: Format,
    pub dynamic_import: bool,
    pub import_meta: bool,
    pub has_export_syntax: bool,
    pub has_import_syntax: bool,
    pub has_dynamic_import: bool,
}

/// A hoisted statement standing for an import, in source order.
enum Record {
    /// `var <name> = require(<source>)`, through `__toESM` when a default or
    /// namespace binding reads it.
    Require { name: RecordName, source: String, to_esm: bool },
    /// `export * from <source>`.
    ReExport { source: String },
}

#[derive(Clone)]
enum RecordName {
    Generated(String),
    /// A namespace import keeps its own binding as the record.
    Symbol(SymbolId),
}

/// What an export's getter returns.
enum ExportValue {
    Symbol(SymbolId),
    Generated(String),
    Member(RecordName, String),
}

/// How a use of an imported binding reads.
#[derive(Clone)]
struct ImportBinding<'a> {
    record: RecordName,
    record_ident: Ident<'a>,
    property: Ident<'a>,
}

pub struct ModulePass<'a> {
    options: ModuleOptions,
    /// ES module syntax is lowered to CommonJS.
    to_cjs: bool,
    /// The module is an ES module: its top-level `this` is undefined.
    is_esm: bool,
    wrap_commonjs: bool,
    names: Option<Names>,
    helpers: Helpers,
    records: Vec<Record>,
    exports: Vec<(String, ExportValue)>,
    bindings: FxHashMap<SymbolId, ImportBinding<'a>>,
    exports_name: Option<String>,
    wrapper_name: Option<String>,
    import_meta_name: Option<Ident<'a>>,
    function_depth: u32,
    this_depth: u32,
    top_level_await: Option<Span>,
    errors: Vec<OxcDiagnostic>,
    warnings: Vec<OxcDiagnostic>,
}

impl<'a> ModulePass<'a> {
    pub fn new(options: ModuleOptions) -> Self {
        Self {
            options,
            to_cjs: false,
            is_esm: false,
            wrap_commonjs: false,
            names: None,
            helpers: Helpers::default(),
            records: Vec::new(),
            exports: Vec::new(),
            bindings: FxHashMap::default(),
            exports_name: None,
            wrapper_name: None,
            import_meta_name: None,
            function_depth: 0,
            this_depth: 0,
            top_level_await: None,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// Run the pass. The outcome is the warnings, or the errors that refuse the module.
    pub fn run(
        mut self,
        allocator: &'a Allocator,
        program: &mut Program<'a>,
        mut scoping: Scoping,
    ) -> (Scoping, Result<Vec<OxcDiagnostic>, Vec<OxcDiagnostic>>) {
        // The TypeScript transform keeps a module whose imports and exports
        // were all types a module with an `export {}` of its own; esbuild
        // emits nothing for them, and what the source said decides the format.
        program.body.retain(
            |s| !matches!(s, Statement::ExportNamedDeclaration(e) if e.specifiers.is_empty() && e.span.is_unspanned()),
        );
        // Imports the transformer injected (the JSX runtime's) have no
        // position; esbuild prints them ahead of the module's own.
        let injected = |s: &Statement<'a>| matches!(s, Statement::ImportDeclaration(i) if i.span.is_unspanned());
        if program.body.iter().any(injected) {
            let (mut synthetic, own): (Vec<_>, Vec<_>) = program.body.take_in(&allocator).into_iter().partition(injected);
            synthetic.extend(own);
            program.body = ArenaVec::from_iter_in(synthetic, &allocator);
        }
        if self.options.format == Format::Esm {
            Self::drop_empty_exports(program, allocator);
        }
        let has_module_syntax = self.options.has_import_syntax
            || self.options.has_export_syntax
            || program.body.iter().any(Statement::is_module_declaration);
        self.is_esm = has_module_syntax;
        self.to_cjs = self.options.format == Format::Cjs && has_module_syntax;
        self.wrap_commonjs = self.options.format == Format::Esm
            && !self.options.has_export_syntax
            && ["module", "exports"].iter().any(|n| scoping.root_unresolved_references().contains_key(*n));
        let lowers_dynamic_import = !self.options.dynamic_import && self.options.has_dynamic_import;

        if self.to_cjs || self.wrap_commonjs || lowers_dynamic_import {
            let mut names = Names::new(&scoping);
            if self.to_cjs {
                self.plan_cjs(program, &mut scoping, &mut names, allocator);
            }
            // A wrap is decided after the traversal (top-level await makes a
            // module ES), so its helper's name is claimed in case.
            let mut claimed = self.helpers;
            if self.wrap_commonjs {
                claimed.add(Helper::CommonJs);
                self.wrapper_name = Some(names.generate("require_stdin", &mut scoping, allocator));
            }
            if lowers_dynamic_import {
                self.helpers.add(Helper::ToEsm);
                claimed.add(Helper::ToEsm);
            }
            for helper in claimed.iter() {
                if scoping.root_unresolved_references().contains_key(helper.name()) {
                    self.errors.push(OxcDiagnostic::error(format!(
                        "This module refers to a global named \"{}\", which module conversion needs for its helper",
                        helper.name()
                    )));
                }
                names.reserve_global(helper.name(), &mut scoping, allocator);
            }
            if !claimed.is_empty() {
                names.reserve_global("Object", &mut scoping, allocator);
            }
            if lowers_dynamic_import {
                names.reserve_global("Promise", &mut scoping, allocator);
            }
            if lowers_dynamic_import || !self.records.is_empty() {
                names.reserve_global("require", &mut scoping, allocator);
            }
            if self.exports_name.is_some() {
                names.reserve_global("module", &mut scoping, allocator);
            }
            self.names = Some(names);
            if !self.errors.is_empty() {
                return (scoping, Err(self.errors));
            }
        }

        let scoping = traverse_mut(&mut self, allocator, program, scoping, ());
        if self.options.format == Format::Cjs
            && let Some(span) = self.top_level_await
        {
            self.errors.push(OxcDiagnostic::error(crate::TOP_LEVEL_AWAIT_CJS).with_label(span));
        }
        if !self.errors.is_empty() {
            return (scoping, Err(self.errors));
        }
        self.finish(allocator, program, &scoping);
        (scoping, Ok(self.warnings))
    }

    /// An ES module printed as one has no empty export lists: `export {}` goes,
    /// and `export {} from "x"` keeps only its import, as esbuild prints them.
    fn drop_empty_exports(program: &mut Program<'a>, allocator: &'a Allocator) {
        let ast = AstBuilder::new(allocator);
        let body = program.body.take_in(&allocator);
        let mut kept = ArenaVec::with_capacity_in(body.len(), &allocator);
        for statement in body {
            match statement {
                Statement::ExportNamedDeclaration(e) if e.specifiers.is_empty() => {}
                Statement::ExportFromDeclaration(e) if e.specifiers.is_empty() => {
                    let ExportFromDeclaration { span, source, with_clause, .. } = e.unbox();
                    kept.push(Statement::new_import_declaration(
                        span,
                        None,
                        source,
                        None,
                        with_clause,
                        ImportOrExportKind::Value,
                        &ast,
                    ));
                }
                statement => kept.push(statement),
            }
        }
        program.body = kept;
    }

    /// Take the module declarations out of the body, recording what each
    /// imports and exports.
    fn plan_cjs(
        &mut self,
        program: &mut Program<'a>,
        scoping: &mut Scoping,
        names: &mut Names,
        allocator: &'a Allocator,
    ) {
        let ast = AstBuilder::new(allocator);
        if self.options.has_export_syntax {
            self.exports_name = Some(names.generate("stdin_exports", scoping, allocator));
            self.helpers.add(Helper::ToCommonJs);
        }
        let body = program.body.take_in(&allocator);
        let mut kept = ArenaVec::with_capacity_in(body.len(), &allocator);
        // Local exports name symbols that an import may bind; resolved once every import is known.
        for statement in body {
            match statement {
                Statement::ImportDeclaration(decl) => {
                    let decl = decl.unbox();
                    self.plan_import(decl, scoping, names, allocator);
                }
                Statement::ExportAllDeclaration(decl) => {
                    let source = decl.source.value.to_string();
                    match &decl.exported {
                        None => {
                            self.helpers.add(Helper::ReExport);
                            self.records.push(Record::ReExport { source });
                        }
                        Some(exported) => {
                            let exported = exported.name().to_string();
                            let name = names.generate(&ensure_valid_identifier(&exported), scoping, allocator);
                            self.helpers.add(Helper::ToEsm);
                            self.records.push(Record::Require {
                                name: RecordName::Generated(name.clone()),
                                source,
                                to_esm: true,
                            });
                            self.exports.push((exported, ExportValue::Generated(name)));
                        }
                    }
                }
                Statement::ExportFromDeclaration(decl) => {
                    let to_esm = decl.specifiers.iter().any(|s| s.local.name() == "default");
                    let source = decl.source.value.to_string();
                    let name = names.generate(&format!("import_{}", name_from_path(&source)), scoping, allocator);
                    if to_esm {
                        self.helpers.add(Helper::ToEsm);
                    }
                    let record = RecordName::Generated(name);
                    self.records.push(Record::Require { name: record.clone(), source, to_esm });
                    for specifier in &decl.specifiers {
                        self.exports.push((
                            specifier.exported.name().to_string(),
                            ExportValue::Member(record.clone(), specifier.local.name().to_string()),
                        ));
                    }
                }
                Statement::ExportNamedDeclaration(decl) => {
                    for specifier in &decl.specifiers {
                        let exported = specifier.exported.name().to_string();
                        let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                            continue;
                        };
                        let symbol = local.reference_id.get().and_then(|id| scoping.get_reference(id).symbol_id());
                        match symbol {
                            Some(symbol) => self.exports.push((exported, ExportValue::Symbol(symbol))),
                            None => self.errors.push(
                                OxcDiagnostic::error(format!("\"{}\" is not declared in this file", local.name))
                                    .with_label(local.span),
                            ),
                        }
                    }
                }
                Statement::ExportDeclaration(decl) => {
                    let decl = decl.unbox();
                    let mut bound = Vec::new();
                    decl.declaration.bound_names(&mut |ident: &BindingIdentifier<'a>| {
                        if let Some(symbol) = ident.symbol_id.get() {
                            bound.push((ident.name.to_string(), symbol));
                        }
                    });
                    for (name, symbol) in bound {
                        self.exports.push((name, ExportValue::Symbol(symbol)));
                    }
                    kept.push(Statement::from(decl.declaration));
                }
                Statement::ExportDefaultDeclaration(decl) => {
                    let ExportDefaultDeclaration { span, declaration, .. } = decl.unbox();
                    match declaration {
                        ExportDefaultDeclarationKind::FunctionDeclaration(mut func) => {
                            let value = match func.id.as_ref().and_then(|id| id.symbol_id.get()) {
                                Some(symbol) => ExportValue::Symbol(symbol),
                                None => {
                                    let name = names.generate("stdin_default", scoping, allocator);
                                    func.id = Some(BindingIdentifier::new(SPAN, Ident::from_str_in(&name, &ast), &ast));
                                    ExportValue::Generated(name)
                                }
                            };
                            self.exports.push(("default".into(), value));
                            kept.push(Statement::FunctionDeclaration(func));
                        }
                        ExportDefaultDeclarationKind::ClassDeclaration(mut class) => {
                            let value = match class.id.as_ref().and_then(|id| id.symbol_id.get()) {
                                Some(symbol) => ExportValue::Symbol(symbol),
                                None => {
                                    let name = names.generate("stdin_default", scoping, allocator);
                                    class.id = Some(BindingIdentifier::new(SPAN, Ident::from_str_in(&name, &ast), &ast));
                                    ExportValue::Generated(name)
                                }
                            };
                            self.exports.push(("default".into(), value));
                            kept.push(Statement::ClassDeclaration(class));
                        }
                        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {}
                        declaration => {
                            let expression = declaration.into_expression();
                            let name = names.generate("stdin_default", scoping, allocator);
                            let id = BindingIdentifier::new(SPAN, Ident::from_str_in(&name, &ast), &ast);
                            let declarator = VariableDeclarator::new(
                                SPAN,
                                BindingPattern::BindingIdentifier(ArenaBox::new_in(id, &allocator)),
                                None,
                                Some(expression),
                                false,
                                &ast,
                            );
                            kept.push(Statement::from(Declaration::new_variable_declaration(
                                span,
                                VariableDeclarationKind::Var,
                                [declarator],
                                false,
                                &ast,
                            )));
                            self.exports.push(("default".into(), ExportValue::Generated(name)));
                        }
                    }
                }
                Statement::TSExportAssignment(_) | Statement::TSNamespaceExportDeclaration(_) => {}
                statement => kept.push(statement),
            }
        }
        if !self.exports.is_empty() {
            self.helpers.add(Helper::Export);
        }
        program.body = kept;
    }

    fn plan_import(
        &mut self,
        decl: ImportDeclaration<'a>,
        scoping: &mut Scoping,
        names: &mut Names,
        allocator: &'a Allocator,
    ) {
        let source = decl.source.value.to_string();
        let specifiers = decl.specifiers.unwrap_or_else(|| ArenaVec::new_in(&allocator));
        let namespace = specifiers.iter().find_map(|s| match s {
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(ns) => ns.local.symbol_id.get(),
            _ => None,
        });
        let to_esm = namespace.is_some()
            || specifiers.iter().any(|s| matches!(s, ImportDeclarationSpecifier::ImportDefaultSpecifier(_)));
        let (record, record_ident) = match namespace {
            Some(symbol) => (RecordName::Symbol(symbol), Ident::from_str_in(scoping.symbol_name(symbol), &allocator)),
            None => {
                let name = names.generate(&format!("import_{}", name_from_path(&source)), scoping, allocator);
                let ident = Ident::from_str_in(&name, &allocator);
                (RecordName::Generated(name), ident)
            }
        };
        for specifier in &specifiers {
            let (local, property) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(s) => (&s.local, s.imported.name().as_str()),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (&s.local, "default"),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => continue,
            };
            if let Some(symbol) = local.symbol_id.get() {
                self.bindings.insert(
                    symbol,
                    ImportBinding {
                        record: record.clone(),
                        record_ident,
                        property: Ident::from_str_in(property, &allocator),
                    },
                );
            }
        }
        if to_esm {
            self.helpers.add(Helper::ToEsm);
        }
        self.records.push(Record::Require { name: record, source, to_esm });
    }

    /// Put the generated statements in front of the body: helpers, then the
    /// exports object, then the imports, then `import_meta`.
    fn finish(&mut self, allocator: &'a Allocator, program: &mut Program<'a>, scoping: &Scoping) {
        // A module with top-level await is an ES module, whatever else it reads.
        let wrap = self.wrap_commonjs && self.top_level_await.is_none();
        if wrap {
            self.helpers.add(Helper::CommonJs);
        }
        let mut text = self.helpers.source();
        let record_name = |name: &RecordName| match name {
            RecordName::Generated(name) => name.clone(),
            RecordName::Symbol(symbol) => scoping.symbol_name(*symbol).to_string(),
        };
        if let Some(exports) = &self.exports_name {
            text.push_str(&format!("var {exports} = {{}};\n"));
            if !self.exports.is_empty() {
                self.exports.sort_by(|a, b| a.0.cmp(&b.0));
                text.push_str(&format!("__export({exports}, {{\n"));
                for (i, (exported, value)) in self.exports.iter().enumerate() {
                    let getter = match value {
                        ExportValue::Symbol(symbol) => match self.bindings.get(symbol) {
                            Some(binding) => member_text(&record_name(&binding.record), &binding.property),
                            None => scoping.symbol_name(*symbol).to_string(),
                        },
                        ExportValue::Generated(name) => name.clone(),
                        ExportValue::Member(record, property) => member_text(&record_name(record), property),
                    };
                    let key = if is_identifier_name(exported) { exported.clone() } else { js_string(exported) };
                    let comma = if i + 1 < self.exports.len() { "," } else { "" };
                    text.push_str(&format!("  {key}: () => {getter}{comma}\n"));
                }
                text.push_str("});\n");
            }
            text.push_str(&format!("module.exports = __toCommonJS({exports});\n"));
        }
        for record in &self.records {
            match record {
                Record::Require { name, source, to_esm } => {
                    let name = record_name(name);
                    let source = js_string(source);
                    if *to_esm {
                        text.push_str(&format!("var {name} = __toESM(require({source}));\n"));
                    } else {
                        text.push_str(&format!("var {name} = require({source});\n"));
                    }
                }
                Record::ReExport { source } => {
                    let exports = self.exports_name.as_deref().expect("export * has an exports object");
                    text.push_str(&format!("__reExport({exports}, require({}), module.exports);\n", js_string(source)));
                }
            }
        }
        if let Some(name) = self.import_meta_name {
            text.push_str(&format!("const {name} = {{}};\n"));
        }
        if wrap {
            self.wrap_commonjs_body(allocator, program, &text);
            return;
        }
        if text.is_empty() {
            return;
        }
        let prologue = parse_statements(allocator, text);
        program.body.splice(0..0, prologue);
    }

    /// `var require_stdin = __commonJS({ "<stdin>"(exports, module) { body } }); export default require_stdin();`,
    /// with the module's imports left in front.
    fn wrap_commonjs_body(&mut self, allocator: &'a Allocator, program: &mut Program<'a>, prologue: &str) {
        let (mut imports, mut body): (Vec<_>, Vec<_>) = program
            .body
            .take_in(&allocator)
            .into_iter()
            .partition(|s| matches!(s, Statement::ImportDeclaration(_)));
        let mut text = prologue.to_string();
        let name = self.wrapper_name.as_deref().expect("a wrapped module has a wrapper name");
        text.push_str(&format!(
            "var {name} = __commonJS({{\n  \"<stdin>\"(exports, module) {{\n  }}\n}});\nexport default {name}();\n"
        ));
        let mut generated = parse_statements(allocator, text);
        // The wrapper's `var` is the second-to-last statement.
        let wrapper = generated.len() - 2;
        if let Statement::VariableDeclaration(var) = &mut generated[wrapper]
            && let Some(Expression::CallExpression(call)) = &mut var.declarations[0].init
            && let Some(Argument::ObjectExpression(object)) = call.arguments.first_mut()
            && let Some(ObjectPropertyKind::ObjectProperty(property)) = object.properties.first_mut()
            && let Expression::FunctionExpression(function) = &mut property.value
            && let Some(function_body) = &mut function.body
        {
            function_body.statements.extend(body.drain(..));
        }
        let mut statements = ArenaVec::with_capacity_in(imports.len() + generated.len(), &allocator);
        let helpers_len = generated.len() - 2;
        let mut generated = generated.into_iter();
        statements.extend(generated.by_ref().take(helpers_len));
        statements.extend(imports.drain(..));
        statements.extend(generated);
        program.body = statements;
    }

    fn rewrite_identifier(&mut self, expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
        let Expression::Identifier(ident) = expr else { return };
        let Some(binding) = ident
            .reference_id
            .get()
            .and_then(|id| ctx.scoping().get_reference(id).symbol_id())
            .and_then(|symbol| self.bindings.get(&symbol))
        else {
            return;
        };
        let span = ident.span;
        let member = binding_member(span, binding, ctx);
        *expr = if matches!(ctx.parent(), Ancestor::CallExpressionCallee(_)) {
            let zero = Expression::new_numeric_literal(SPAN, 0.0, None, NumberBase::Decimal, ctx);
            Expression::new_sequence_expression(span, [zero, member], ctx)
        } else {
            member
        };
    }

    fn import_meta(&mut self, expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
        let Expression::ImportMeta(meta) = expr else { return };
        if self.options.format != Format::Cjs && self.options.import_meta {
            return;
        }
        let span = meta.span;
        let name = match self.import_meta_name {
            Some(name) => name,
            None => {
                let allocator = ctx.allocator();
                let names = self.names.get_or_insert_with(|| Names::new(ctx.scoping()));
                let name = names.generate("import_meta", ctx.scoping_mut(), allocator);
                let ident = Ident::from_str_in(&name, ctx);
                self.import_meta_name = Some(ident);
                ident
            }
        };
        self.warnings.push(
            OxcDiagnostic::warn(if self.options.format == Format::Cjs {
                "\"import.meta\" is not available with the \"cjs\" output format and will be empty"
            } else {
                "\"import.meta\" is not available in the configured target environment and will be empty"
            })
            .with_label(span),
        );
        *expr = Expression::new_identifier(span, name, ctx);
    }

    /// `import(x)` → `Promise.resolve().then(() => __toESM(require(x)))`.
    fn lower_dynamic_import(&mut self, expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
        if self.options.dynamic_import {
            return;
        }
        let Expression::ImportExpression(import) = expr else { return };
        let span = import.span;
        let allocator = ctx.allocator();
        let source = import.source.take_in(&allocator);
        let mut lowered = parse_expression(allocator, "Promise.resolve().then(() => __toESM(require(0)))");
        if let Expression::CallExpression(then) = &mut lowered
            && let Some(Argument::ArrowFunctionExpression(arrow)) = then.arguments.first_mut()
            && let ArrowFunctionBody::CallExpression(to_esm) = &mut arrow.body
            && let Some(Argument::CallExpression(require)) = to_esm.arguments.first_mut()
            && let Some(argument) = require.arguments.first_mut()
        {
            *argument = Argument::from(source);
        }
        if let Expression::CallExpression(then) = &mut lowered {
            then.span = span;
        }
        *expr = lowered;
    }
}

impl<'a> Traverse<'a, ()> for ModulePass<'a> {
    fn enter_expression(&mut self, expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
        match expr {
            Expression::Identifier(_) if !self.bindings.is_empty() => self.rewrite_identifier(expr, ctx),
            Expression::ImportMeta(_) => self.import_meta(expr, ctx),
            Expression::ThisExpression(this) if self.is_esm && self.this_depth == 0 => {
                let span = this.span;
                let zero = Expression::new_numeric_literal(SPAN, 0.0, None, NumberBase::Decimal, ctx);
                *expr = Expression::new_unary_expression(span, UnaryOperator::Void, zero, ctx);
            }
            _ => {}
        }
    }

    // On exit: the lowering's arrow function has no scope of its own to walk
    // into, and the source it wraps has had its own uses rewritten.
    fn exit_expression(&mut self, expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
        match expr {
            Expression::ImportExpression(import) => {
                // esbuild reads an import path written as a template with
                // nothing substituted as the string it is, and prints it so;
                // so does a CommonJS output's `require(`x`)`, below.
                template_as_string(&mut import.source, ctx);
                self.lower_dynamic_import(expr, ctx);
            }
            Expression::CallExpression(call)
                if self.options.format == Format::Cjs
                    && call.arguments.len() == 1
                    && matches!(&call.callee, Expression::Identifier(id) if id.name == "require"
                        && id.reference_id.get().is_some_and(|r| ctx.scoping().get_reference(r).symbol_id().is_none())) =>
            {
                if let Some(argument) = call.arguments[0].as_expression_mut() {
                    template_as_string(argument, ctx);
                }
            }
            _ => {}
        }
    }

    fn enter_simple_assignment_target(
        &mut self,
        target: &mut SimpleAssignmentTarget<'a>,
        ctx: &mut TraverseCtx<'a>,
    ) {
        let SimpleAssignmentTarget::AssignmentTargetIdentifier(ident) = target else { return };
        let Some(binding) = ident
            .reference_id
            .get()
            .and_then(|id| ctx.scoping().get_reference(id).symbol_id())
            .and_then(|symbol| self.bindings.get(&symbol))
            .cloned()
        else {
            return;
        };
        self.warnings.push(
            OxcDiagnostic::warn(format!("This assignment will throw because \"{}\" is an import", ident.name))
                .with_label(ident.span),
        );
        let span = ident.span;
        if let Expression::StaticMemberExpression(member) = binding_member(span, &binding, ctx) {
            *target = SimpleAssignmentTarget::StaticMemberExpression(member);
        } else if let Expression::ComputedMemberExpression(member) = binding_member(span, &binding, ctx) {
            *target = SimpleAssignmentTarget::ComputedMemberExpression(member);
        }
    }

    fn enter_function(&mut self, _: &mut Function<'a>, _: &mut TraverseCtx<'a>) {
        self.function_depth += 1;
        self.this_depth += 1;
    }

    fn exit_function(&mut self, _: &mut Function<'a>, _: &mut TraverseCtx<'a>) {
        self.function_depth -= 1;
        self.this_depth -= 1;
    }

    fn enter_arrow_function_expression(&mut self, _: &mut ArrowFunctionExpression<'a>, _: &mut TraverseCtx<'a>) {
        self.function_depth += 1;
    }

    fn exit_arrow_function_expression(&mut self, _: &mut ArrowFunctionExpression<'a>, _: &mut TraverseCtx<'a>) {
        self.function_depth -= 1;
    }

    fn enter_class_body(&mut self, _: &mut ClassBody<'a>, _: &mut TraverseCtx<'a>) {
        self.this_depth += 1;
    }

    fn exit_class_body(&mut self, _: &mut ClassBody<'a>, _: &mut TraverseCtx<'a>) {
        self.this_depth -= 1;
    }

    fn enter_await_expression(&mut self, expr: &mut AwaitExpression<'a>, _: &mut TraverseCtx<'a>) {
        if self.function_depth == 0 && self.top_level_await.is_none() {
            self.top_level_await = Some(expr.span);
        }
    }

    fn enter_for_of_statement(&mut self, stmt: &mut ForOfStatement<'a>, _: &mut TraverseCtx<'a>) {
        if stmt.r#await && self.function_depth == 0 && self.top_level_await.is_none() {
            self.top_level_await = Some(Span::new(stmt.span.start + 4, stmt.span.start + 9));
        }
    }

    fn enter_variable_declaration(&mut self, decl: &mut VariableDeclaration<'a>, _: &mut TraverseCtx<'a>) {
        if decl.kind == VariableDeclarationKind::AwaitUsing && self.function_depth == 0 && self.top_level_await.is_none() {
            self.top_level_await = Some(decl.span);
        }
    }
}

/// A template with nothing substituted, as the string literal it evaluates to.
fn template_as_string<'a>(expr: &mut Expression<'a>, ctx: &mut TraverseCtx<'a>) {
    if let Expression::TemplateLiteral(template) = expr
        && template.expressions.is_empty()
        && !template.quasis[0].lone_surrogates
        && let Some(cooked) = template.quasis[0].value.cooked
    {
        *expr = Expression::new_string_literal(template.span, cooked, None, ctx);
    }
}

/// `record.property`, or `record["property"]` for a name that is not an identifier.
fn binding_member<'a>(span: Span, binding: &ImportBinding<'a>, ctx: &mut TraverseCtx<'a>) -> Expression<'a> {
    let object = match binding.record {
        RecordName::Symbol(symbol) => {
            ctx.create_bound_ident_expr(SPAN, binding.record_ident, symbol, oxc::semantic::ReferenceFlags::Read)
        }
        RecordName::Generated(_) => Expression::new_identifier(SPAN, binding.record_ident, ctx),
    };
    if is_identifier_name(&binding.property) {
        let property = IdentifierName::new(SPAN, binding.property, ctx);
        Expression::new_static_member_expression(span, object, property, false, ctx)
    } else {
        let key = Expression::new_string_literal(SPAN, binding.property.as_arena_str(), None, ctx);
        Expression::new_computed_member_expression(span, object, key, false, ctx)
    }
}

fn member_text(object: &str, property: &str) -> String {
    if is_identifier_name(property) { format!("{object}.{property}") } else { format!("{object}[{}]", js_string(property)) }
}

/// A double-quoted JavaScript string literal.
fn js_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Parse generated statements into the module's arena, without positions:
/// they have no place in the source, so neither comments nor source maps may
/// attach to them.
fn parse_statements<'a>(allocator: &'a Allocator, text: String) -> ArenaVec<'a, Statement<'a>> {
    let text = allocator.alloc_str(&text);
    let mut parsed = Parser::new(allocator, text, SourceType::mjs()).parse();
    debug_assert!(parsed.diagnostics.is_empty(), "generated code parses: {text}");
    ZeroSpans.visit_program(&mut parsed.program);
    parsed.program.body
}

fn parse_expression<'a>(allocator: &'a Allocator, text: &'static str) -> Expression<'a> {
    let mut statements = parse_statements(allocator, text.to_string());
    match statements.pop() {
        Some(Statement::ExpressionStatement(statement)) => statement.unbox().expression,
        _ => unreachable!("an expression statement"),
    }
}

struct ZeroSpans;

impl<'a> VisitMut<'a> for ZeroSpans {
    fn visit_span(&mut self, span: &mut Span) {
        *span = SPAN;
    }
}
