//! Nimbus's JavaScript/TypeScript transform: Oxc's parser, semantic analysis,
//! TypeScript/JSX transformer, global defines and code generator, plus the one
//! pass Oxc does not have, `module.rs`: ES module to CommonJS (and the
//! `import.meta`, dynamic `import()` and top-level `this` handling that goes
//! with a module format), shaped like esbuild 0.24's transform output, which
//! is the contract the rest of Nimbus was built against.
//!
//! The crate is a pure function from (source, options) to (code, map,
//! diagnostics). `abi.rs` exposes it to JavaScript as a wasm32 module with no
//! imports.

mod diagnostics;
mod helpers;
mod module;
mod names;
pub mod options;
mod runtime_helpers;

#[cfg(target_arch = "wasm32")]
mod abi;

use oxc::allocator::Allocator;
use oxc::ast::ast::{Program, Statement};
use oxc::codegen::{Codegen, CodegenOptions, CommentOptions, LegalComment};
use oxc::parser::{ParseOptions, Parser};
use oxc::semantic::SemanticBuilder;
use oxc::diagnostics::OxcDiagnostic;
use oxc::span::{SourceType, Span};
use oxc::transformer::{
    ClassPropertiesOptions, CompilerAssumptions, DecoratorOptions, ES2022Options,
    EnvOptions, JsxOptions, JsxRuntime, TransformOptions, Transformer, TypeScriptOptions,
};
use oxc::transformer_plugins::{ReplaceGlobalDefines, ReplaceGlobalDefinesConfig};

pub use diagnostics::Diagnostic;
use options::{JsxMode, Loader, Options, SourceMapMode};

/// What one transform produced. `code` is empty when `diagnostics` holds an error.
pub struct Output {
    pub code: String,
    /// The source map JSON, for `SourceMapMode::External`.
    pub map: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Output {
    fn failed(diagnostics: Vec<Diagnostic>) -> Self {
        Self { code: String::new(), map: None, diagnostics }
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics.iter().any(|d| d.error)
    }
}

/// Transform `source` as `options` describe, allocating the AST in `allocator`.
pub fn transform(allocator: &Allocator, source: &str, options: &Options) -> Output {
    let source_type = match options.loader {
        Loader::Js => SourceType::unambiguous(),
        Loader::Jsx => SourceType::unambiguous().with_jsx(true),
        Loader::Ts => SourceType::ts().with_unambiguous(true),
        Loader::Tsx => SourceType::tsx().with_unambiguous(true),
    };
    let sourcefile = options.sourcefile.as_deref().unwrap_or("<stdin>");
    let parse = |source_type, allow_return_outside_function| {
        Parser::new(allocator, source, source_type)
            .with_options(ParseOptions {
                preserve_parens: false,
                allow_return_outside_function,
                ..ParseOptions::default()
            })
            .parse()
    };
    let failed = |parsed: &oxc::parser::ParserReturn<'_>| parsed.diagnostics.has_errors() || parsed.fatal_error;
    let mut parsed = parse(source_type, false);
    let mut parsed_as_module = false;
    // Where a top-level `return` is, in a source that only parses with one.
    let mut top_level_return = None;
    if failed(&parsed) {
        // Unambiguous parsing reads top-level `await` as a module's, but not
        // `for await`: a source only a module can be is parsed as one. A
        // CommonJS module may `return` at its top level (its wrapper is a
        // function), which an ES module may not: that is decided below.
        let as_module = parse(source_type.with_module(true), false);
        if !failed(&as_module) {
            parsed = as_module;
            parsed_as_module = true;
        } else {
            let with_return = parse(source_type, true);
            if failed(&with_return) {
                return Output::failed(diagnostics::convert(source, sourcefile, parsed.diagnostics.into_vec()));
            }
            top_level_return = parsed.diagnostics.iter().find_map(|d| d.labels.first()).map(|label| {
                Span::sized(label.offset() as u32, label.span().size())
            });
            parsed = with_return;
        }
    }
    if options.always_strict
        && !parsed.program.source_type.is_strict()
        && !parsed.program.directives.iter().any(|d| d.directive.as_str() == "use strict")
    {
        let errors = strict_errors(source, source_type, top_level_return.is_some(), sourcefile);
        if !errors.is_empty() {
            return Output::failed(errors);
        }
    }
    let has_dynamic_import = !parsed.module_record.dynamic_imports.is_empty();
    let has_import_meta = !parsed.module_record.import_metas.is_empty();
    let mut program = parsed.program;
    // Export syntax decides whether the module gets an exports object, even
    // when all of it is TypeScript types the transformer is about to erase.
    let has_export_syntax = program.body.iter().any(is_export_statement);

    let semantic = SemanticBuilder::new().with_check_syntax_error(true).with_enum_eval(true).build(&program);
    if semantic.diagnostics.has_errors() {
        return Output::failed(diagnostics::convert(source, sourcefile, semantic.diagnostics.into_vec()));
    }
    let mut scoping = semantic.semantic.into_scoping();
    let mut warnings = Vec::new();

    if source_type.is_typescript() || source_type.is_jsx() {
        // A constant fragment is named by a placeholder no binding or
        // reference of the module's has (however its source spells them),
        // then put in its place: every reference by that name is the
        // transform's.
        let fragment = options.jsx_fragment_constant.as_ref().filter(|_| options.jsx == JsxMode::Transform).map(|constant| {
            let taken = |name: &str| {
                scoping.symbol_names().any(|symbol| symbol == name)
                    || scoping.root_unresolved_references().keys().any(|reference| reference.as_str() == name)
            };
            let mut name = String::from("__nimbusJsxFragment");
            while taken(&name) {
                name.push('_');
            }
            (name, constant)
        });
        // Each import with a clause (`{...}`, a default or a namespace): where
        // it starts, its source, and whether it is a value import (not `import type`).
        let with_clause: Vec<(u32, &str, bool)> = program
            .body
            .iter()
            .filter_map(|statement| match statement {
                Statement::ImportDeclaration(d) if d.specifiers.is_some() => {
                    Some((d.span.start, d.source.value.as_str(), d.import_kind.is_value()))
                }
                _ => None,
            })
            .collect();
        let parameter_properties = (source_type.is_typescript() && !options.assign_class_fields).then(|| parameter_properties(&program));
        let transform_options = transform_options(options, fragment.as_ref().map(|(name, _)| name.as_str()), source_type.is_typescript());
        let transformed = Transformer::new(allocator, std::path::Path::new(sourcefile), &transform_options)
            .build_with_scoping(scoping, &mut program);
        if transformed.diagnostics.has_errors() {
            return Output::failed(diagnostics::convert(source, sourcefile, transformed.diagnostics.into_vec()));
        }
        scoping = transformed.scoping;
        if let Some(names) = &parameter_properties {
            drop_parameter_property_fields(&mut program, names);
        }
        if source_type.is_typescript() && options.experimental_decorators {
            decorate_in_tsc_order(&mut program);
        }
        let mut read = inline_runtime_helpers(allocator, &mut program);
        if options.assign_class_fields && source_type.is_typescript() {
            // Lowered private fields and methods are kept in these.
            read.extend(["WeakMap", "WeakSet"].map(String::from));
        }
        if !read.is_empty() {
            // What the helpers and the lowering read of the globals is no
            // module binding's: one that would shadow it is renamed, as
            // esbuild renames it (`Object2`), on the transformer's scoping,
            // which knows the module's own symbols from what was generated.
            rename_shadowing_bindings(allocator, &mut program, &mut scoping, &read);
            // The helpers' declarations are new: their scoping is made again.
            scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
        }
        if options.jsx == JsxMode::Automatic && options.jsx_dev {
            strip_dev_fallback_props(&mut program, options.jsx_import_source.as_deref().unwrap_or("react"));
        }
        if let Some((name, constant)) = &fragment {
            use oxc::ast_visit::VisitMut;
            ConstantFragment { allocator, name, constant }.visit_program(&mut program);
        }
        if source_type.is_typescript() && !options.keep_statements {
            // esbuild (as TypeScript) drops an import its elision leaves with
            // an empty clause (`import {} from "x"`, or every specifier a
            // type); verbatimModuleSyntax keeps it. `import "x"` had no clause.
            program.body.retain(|statement| match statement {
                Statement::ImportDeclaration(d) => {
                    !(d.specifiers.as_ref().is_none_or(|s| s.is_empty())
                        && !d.span.is_empty()
                        && with_clause.iter().any(|(start, _, _)| *start == d.span.start))
                }
                _ => true,
            });
        }
        if source_type.is_typescript() && options.keep_statements && !options.keep_values {
            keep_statements(allocator, &mut program, &with_clause);
        }
    }

    if !options.define.is_empty() {
        let config = match ReplaceGlobalDefinesConfig::new(&options.define) {
            Ok(config) => config,
            Err(errors) => return Output::failed(diagnostics::convert(source, sourcefile, errors.into_vec())),
        };
        scoping = ReplaceGlobalDefines::new(allocator, config).build(scoping, &mut program).scoping;
    }

    // An ES module, as esbuild decides it: export syntax (types included), an
    // import that survived TypeScript's elision, `import.meta`, or top-level
    // await (what made a parse as a module the only one that succeeds).
    let mut is_esm = has_export_syntax
        || has_import_meta
        || parsed_as_module
        || program.body.iter().any(|s| matches!(s, Statement::ImportDeclaration(_)));
    // Unambiguous parsing accepts `await` at the top of a script; only `this`
    // reads the difference, so only a source with both is walked for it.
    if !is_esm && memchr::memmem::find(source.as_bytes(), b"await").is_some() && memchr::memmem::find(source.as_bytes(), b"this").is_some() {
        is_esm = module::has_top_level_await(&program);
    }
    if is_esm && let Some(span) = top_level_return {
        let error = OxcDiagnostic::error("Top-level return cannot be used inside an ECMAScript module").with_label(span);
        return Output::failed(diagnostics::convert(source, sourcefile, vec![error]));
    }
    let pass = module::ModulePass::new(module::ModuleOptions {
        format: options.format,
        dynamic_import: options.supported_dynamic_import,
        import_meta: options.supported_import_meta,
        is_esm,
        has_export_syntax,
        has_import_meta,
        has_dynamic_import,
    });
    let (scoping, outcome) = pass.run(allocator, &mut program, scoping);
    match outcome {
        Err(errors) => return Output::failed(diagnostics::convert(source, sourcefile, errors)),
        Ok(pass_warnings) => warnings.extend(pass_warnings),
    }
    if options.always_strict && options.format == options::Format::Cjs {
        use_strict(allocator, &mut program);
    }

    let (code, map) = generate(&program, scoping, options, sourcefile);
    Output { code, map, diagnostics: diagnostics::convert(source, sourcefile, warnings) }
}

fn generate(
    program: &Program<'_>,
    scoping: oxc::semantic::Scoping,
    options: &Options,
    sourcefile: &str,
) -> (String, Option<String>) {
    let codegen_options = CodegenOptions {
        // esbuild's default charset is ASCII: everything else is escaped.
        ascii_only: true,
        indent_char: oxc::codegen::IndentChar::Space,
        indent_width: 2,
        comments: CommentOptions {
            normal: false,
            jsdoc: false,
            annotation: true,
            legal: LegalComment::Inline,
            ..CommentOptions::default()
        },
        source_map_path: (options.sourcemap != SourceMapMode::None).then(|| sourcefile.into()),
        ..CodegenOptions::default()
    };
    let generated = Codegen::new().with_options(codegen_options).with_scoping(Some(scoping)).build(program);
    let mut code = generated.code;
    let map = generated.map.map(|mut map| {
        map.set_source_contents(vec![Some(program.source_text)]);
        map
    });
    match (options.sourcemap, map) {
        (SourceMapMode::Inline, Some(map)) => {
            if !code.ends_with('\n') {
                code.push('\n');
            }
            code.push_str("//# sourceMappingURL=");
            code.push_str(&map.to_data_url());
            code.push('\n');
            (code, None)
        }
        (SourceMapMode::External, Some(map)) => (code, Some(map.to_json_string())),
        _ => (code, None),
    }
}

/// Each class's parameter properties (`constructor(public q)`), by name, in
/// the order a visit meets the classes.
fn parameter_properties(program: &Program<'_>) -> Vec<Vec<String>> {
    use oxc::ast::ast::{Class, ClassElement, MethodDefinitionKind};
    use oxc::ast_visit::{Visit, walk};
    struct Collect(Vec<Vec<String>>);
    impl<'a> Visit<'a> for Collect {
        fn visit_class(&mut self, class: &Class<'a>) {
            let names = class
                .body
                .body
                .iter()
                .find_map(|element| match element {
                    ClassElement::MethodDefinition(m) if m.kind == MethodDefinitionKind::Constructor => Some(&m.value.params.items),
                    _ => None,
                })
                .map(|params| {
                    params
                        .iter()
                        .filter(|p| p.accessibility.is_some() || p.readonly || p.r#override)
                        .filter_map(|p| p.pattern.get_identifier_name().map(|name| name.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            // A field the class writes of the same name is its own (Oxc adds
            // none beside it, and esbuild keeps it): only the others are Oxc's.
            let written: Vec<String> = class
                .body
                .body
                .iter()
                .filter_map(|element| match element {
                    ClassElement::PropertyDefinition(p) if !p.declare && !p.r#static => p.key.static_name().map(|n| n.to_string()),
                    _ => None,
                })
                .collect();
            self.0.push(names.into_iter().filter(|name| !written.contains(name)).collect());
            walk::walk_class(self, class);
        }
    }
    let mut collect = Collect(Vec::new());
    collect.visit_program(program);
    collect.0
}

/// Oxc's TypeScript transform declares a field for each parameter property
/// (`q;`, first in the class), as tsc does under useDefineForClassFields;
/// esbuild assigns it in the constructor alone. Those declarations go, so the
/// object's own keys are in esbuild's order (the fields', then the parameter
/// properties'). `names` is, per class, the parameter properties the class
/// does not also write as a field: Oxc adds no declaration beside a written
/// one, and esbuild keeps the written one where it is. The transform keeps
/// the classes and their order; were it not to, nothing is taken.
fn drop_parameter_property_fields(program: &mut Program<'_>, names: &[Vec<String>]) {
    use oxc::ast::ast::{Class, ClassElement};
    use oxc::ast_visit::{Visit, VisitMut, walk, walk_mut};
    struct Count(usize);
    impl<'a> Visit<'a> for Count {
        fn visit_class(&mut self, class: &Class<'a>) {
            self.0 += 1;
            walk::walk_class(self, class);
        }
    }
    if names.iter().all(Vec::is_empty) {
        return;
    }
    let mut count = Count(0);
    count.visit_program(program);
    if count.0 != names.len() {
        return;
    }
    struct Drop<'n>(&'n [Vec<String>], usize);
    impl<'a> VisitMut<'a> for Drop<'_> {
        fn visit_class(&mut self, class: &mut Class<'a>) {
            let names = &self.0[self.1];
            self.1 += 1;
            if !names.is_empty() {
                class.body.body.retain(|element| {
                    !matches!(element, ClassElement::PropertyDefinition(p)
                        if p.value.is_none() && !p.r#static && !p.declare
                            && p.key.static_name().is_some_and(|key| names.iter().any(|name| *name == key)))
                });
            }
            walk_mut::walk_class(self, class);
        }
    }
    Drop(names, 0).visit_program(program);
}

/// Where Oxc's transformer imports its helpers from (its Runtime mode).
const RUNTIME_HELPERS: &str = "@oxc-project/runtime/helpers/";

/// The local name of the helper `name` the transformer imported, if it did.
fn runtime_helper_local<'p>(program: &'p Program<'_>, name: &str) -> Option<&'p str> {
    use oxc::ast::ast::ImportDeclarationSpecifier;
    program.body.iter().find_map(|statement| match statement {
        // The transformer's own import has no span; one the module wrote is the module's.
        Statement::ImportDeclaration(d) if d.span.is_empty() && d.source.value.as_str().strip_prefix(RUNTIME_HELPERS) == Some(name) => {
            match d.specifiers.as_ref()?.first()? {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => Some(s.local.name.as_str()),
                _ => None,
            }
        }
        _ => None,
    })
}

/// Each import of an @oxc-project/runtime helper the transformer added
/// (`import _decorate from "@oxc-project/runtime/helpers/decorate"`), made
/// the helper itself, as esbuild's output carries its own:
/// `var _decorate = (() => { ...; return __decorate; })();`, what the helper
/// imports defined inside the same function, so no name of theirs reaches
/// the module's scope. Returns whether there was any.
fn inline_runtime_helpers<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> Vec<String> {
    use oxc::ast::ast::ImportDeclarationSpecifier;
    let mut read: Vec<String> = Vec::new();
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(d) = statement else { continue };
        // Only the transformer's (no span): an import the module wrote is its
        // own, kept, so a stateful helper keeps one state across modules.
        if !d.span.is_empty() {
            continue;
        }
        let Some(name) = d.source.value.as_str().strip_prefix(RUNTIME_HELPERS) else { continue };
        let Some(ImportDeclarationSpecifier::ImportDefaultSpecifier(local)) = d.specifiers.as_ref().and_then(|s| s.first()) else {
            continue;
        };
        let mut body = String::new();
        let mut seen = Vec::new();
        let Some(function) = emit_runtime_helper(name, &mut body, &mut seen) else { continue };
        let text = format!("var {} = /* @__PURE__ */ (() => {{\n{body}return {function};\n}})();", local.local.name);
        for global in globals_read(&text) {
            if !read.contains(&global) {
                read.push(global);
            }
        }
        if let Some(helper) = module::parse_statements(allocator, text).pop() {
            *statement = helper;
        }
    }
    read
}

/// Renames every module binding named one of `globals` (the generated code
/// reads them as globals) and the references the module wrote to it, in the
/// AST: the scoping is made again after, from the names. An exported
/// declaration of one keeps its export name (`const Object2 = 0; export {
/// Object2 as Object }`). A generated reference (no span) keeps the global's
/// name: it is the global, now that nothing of the module shadows it.
fn rename_shadowing_bindings<'a>(allocator: &'a Allocator, program: &mut Program<'a>, scoping: &mut oxc::semantic::Scoping, globals: &[String]) {
    use oxc::ast::ast::{BindingIdentifier, IdentifierReference};
    use oxc::ast_visit::{VisitMut, walk_mut};
    use oxc::semantic::SymbolId;
    let mut names = names::Names::new(scoping);
    let before: Vec<(SymbolId, String)> = scoping
        .symbol_ids()
        .filter(|&symbol| globals.iter().any(|g| g == scoping.symbol_name(symbol)))
        .map(|symbol| (symbol, scoping.symbol_name(symbol).to_string()))
        .collect();
    if before.is_empty() {
        return;
    }
    for name in globals {
        names.reserve_global(name, scoping, allocator);
    }
    let renamed: Vec<(SymbolId, String)> = before
        .into_iter()
        .filter_map(|(symbol, old)| {
            let new = scoping.symbol_name(symbol);
            (new != old).then(|| (symbol, new.to_string()))
        })
        .collect();
    module::ModulePass::alias_renamed_exports(program, scoping, allocator);
    struct Rename<'s, 'a> {
        allocator: &'a Allocator,
        scoping: &'s oxc::semantic::Scoping,
        renamed: &'s [(SymbolId, String)],
    }
    impl<'a> VisitMut<'a> for Rename<'_, 'a> {
        fn visit_binding_identifier(&mut self, it: &mut BindingIdentifier<'a>) {
            if let Some(symbol) = it.symbol_id.get()
                && let Some((_, new)) = self.renamed.iter().find(|(s, _)| *s == symbol)
            {
                it.name = oxc::str::Ident::from_str_in(new, &self.allocator);
            }
        }
        fn visit_identifier_reference(&mut self, it: &mut IdentifierReference<'a>) {
            if it.span.is_empty() {
                return;
            }
            if let Some(reference) = it.reference_id.get()
                && let Some(symbol) = self.scoping.get_reference(reference).symbol_id()
                && let Some((_, new)) = self.renamed.iter().find(|(s, _)| *s == symbol)
            {
                it.name = oxc::str::Ident::from_str_in(new, &self.allocator);
            }
            walk_mut::walk_identifier_reference(self, it);
        }
    }
    Rename { allocator, scoping, renamed: &renamed }.visit_program(program);
}

/// The globals `text` reads: its unresolved references, but the one it
/// assigns (its own binding, resolved where it is inserted).
fn globals_read(text: &str) -> Vec<String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, text, SourceType::mjs()).parse();
    let scoping = SemanticBuilder::new().build(&parsed.program).semantic.into_scoping();
    let declared: Vec<&str> = scoping.symbol_names().collect();
    scoping
        .root_unresolved_references()
        .keys()
        .map(|name| name.as_str())
        .filter(|name| !declared.contains(name))
        .filter(|name| !text.starts_with(&format!("var {name} ")))
        .map(String::from)
        .collect()
}

/// The helper `name`'s source, after the helpers it imports (each once, and
/// bound to the name it imports it by), into `out`; its function's name.
fn emit_runtime_helper(name: &str, out: &mut String, seen: &mut Vec<String>) -> Option<String> {
    let source = runtime_helpers::HELPERS.iter().find(|(helper, _)| *helper == name)?.1;
    let function = source.lines().find_map(|line| line.strip_prefix("export { ")?.strip_suffix(" as default };"))?.to_string();
    if seen.iter().any(|helper| helper == name) {
        return Some(function);
    }
    seen.push(name.to_string());
    for line in source.lines() {
        if let Some(rest) = line.strip_prefix("import ")
            && let Some((alias, dependency)) = rest.split_once(" from \"./")
        {
            let dependency = emit_runtime_helper(dependency.strip_suffix(".js\";")?, out, seen)?;
            if alias != dependency {
                out.push_str(&format!("var {alias} = {dependency};\n"));
            }
        }
    }
    for line in source.lines().filter(|line| !line.starts_with("import ") && !line.starts_with("export { ")) {
        out.push_str(line);
        out.push('\n');
    }
    Some(function)
}

/// tsc applies a class's decorators to its instance members first, then to
/// its static members, then to the class (its constructor's parameters
/// with it), each group in source order; esbuild too. Oxc's legacy
/// transform calls them in source order, one statement each after the class:
/// `_decorate([..], A.prototype, "m", null)`, `_decorate([..], A, "s", ..)`,
/// `A = _decorate([..], A)`. Each class's run of them is put in tsc's order.
fn decorate_in_tsc_order(program: &mut Program<'_>) {
    use oxc::ast::ast::{Argument, AssignmentTarget, Expression};
    use oxc::ast_visit::{VisitMut, walk_mut};
    let Some(decorate) = runtime_helper_local(program, "decorate").map(str::to_string) else { return };
    // (0 instance member, 1 static member, 2 the class; the class's name)
    fn kind(statement: &Statement<'_>, decorate: &str) -> Option<(u8, String)> {
        let Statement::ExpressionStatement(statement) = statement else { return None };
        let is_decorate = |e: &Expression<'_>| matches!(e, Expression::CallExpression(c) if matches!(&c.callee, Expression::Identifier(i) if i.name.as_str() == decorate));
        match &statement.expression {
            Expression::CallExpression(call) if is_decorate(&statement.expression) => match call.arguments.get(1)? {
                Argument::StaticMemberExpression(m) if m.property.name.as_str() == "prototype" => match &m.object {
                    Expression::Identifier(class) => Some((0, class.name.to_string())),
                    _ => None,
                },
                Argument::Identifier(class) => Some((1, class.name.to_string())),
                _ => None,
            },
            Expression::AssignmentExpression(assign) if is_decorate(&assign.right) => match &assign.left {
                AssignmentTarget::AssignmentTargetIdentifier(class) => Some((2, class.name.to_string())),
                _ => None,
            },
            _ => None,
        }
    }
    struct Order(String);
    impl<'a> VisitMut<'a> for Order {
        fn visit_statements(&mut self, statements: &mut oxc::allocator::Vec<'a, Statement<'a>>) {
            walk_mut::walk_statements(self, statements);
            let mut i = 0;
            while i < statements.len() {
                let Some((_, class)) = kind(&statements[i], &self.0) else {
                    i += 1;
                    continue;
                };
                let mut end = i + 1;
                while end < statements.len() && kind(&statements[end], &self.0).is_some_and(|(_, c)| c == class) {
                    end += 1;
                }
                statements[i..end].sort_by_key(|s| kind(s, &self.0).map(|(rank, _)| rank));
                i = end;
            }
        }
    }
    Order(decorate).visit_program(program);
}

/// esbuild's KeepStmt without KeepValues (`importsNotUsedAsValues`
/// `preserve` or `error`): a value import whose every specifier went unused
/// stays, as `import "x"`, where Oxc's elision dropped it whole. `with_clause`
/// is each import with a clause before elision (`transform`); one gone from the
/// body comes back bare, where it was.
fn keep_statements<'a>(allocator: &'a Allocator, program: &mut Program<'a>, with_clause: &[(u32, &str, bool)]) {
    use oxc::ast::ast::{ImportOrExportKind, StringLiteral};
    use oxc::span::GetSpan;
    let present: Vec<u32> = program
        .body
        .iter()
        .filter_map(|statement| match statement {
            // The transform's own imports (the JSX runtime's) have no span: none of them is the source's.
            Statement::ImportDeclaration(d) if !d.span.is_empty() => Some(d.span.start),
            _ => None,
        })
        .collect();
    let mut missing = with_clause.iter().filter(|(start, _, value)| *value && !present.contains(start)).peekable();
    if missing.peek().is_none() {
        return;
    }
    let ast = oxc::ast::builder::AstBuilder::new(allocator);
    let bare = |start: u32, source: &str| {
        let span = Span::new(start, start);
        let literal = StringLiteral::new(span, allocator.alloc_str(source), None, &ast);
        Statement::new_import_declaration(span, None, literal, None, None, ImportOrExportKind::Value, &ast)
    };
    let mut body = oxc::allocator::Vec::with_capacity_in(program.body.len() + with_clause.len(), &allocator);
    for statement in program.body.drain(..) {
        // What the transform made (at 0) stays first.
        let start = statement.span().start;
        while start != 0 && let Some((at, source, _)) = missing.next_if(|(at, _, _)| *at < start) {
            body.push(bare(*at, source));
        }
        body.push(statement);
    }
    for (at, source, _) in missing {
        body.push(bare(*at, source));
    }
    program.body = body;
}

/// The errors esbuild reports for a source under tsconfig's `alwaysStrict`,
/// which it parses as strict code: what a sloppy script may contain and a
/// strict one may not (`with`, a legacy octal, `delete x`, ...). The source
/// is parsed again behind a `"use strict"` line only to find them, each
/// placed in the source itself (a hashbang becomes a comment of its length);
/// the sloppy parse is otherwise the same program.
fn strict_errors(source: &str, source_type: SourceType, allow_return_outside_function: bool, sourcefile: &str) -> Vec<Diagnostic> {
    use oxc::diagnostics::Severity;
    let body = match source.strip_prefix("#!") {
        Some(rest) => format!("//{rest}"),
        None => source.to_string(),
    };
    let text = format!("\"use strict\";\n{body}");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &text, source_type)
        .with_options(ParseOptions { preserve_parens: false, allow_return_outside_function, ..ParseOptions::default() })
        .parse();
    let mut errors: Vec<OxcDiagnostic> = parsed.diagnostics.into_vec();
    if !errors.iter().any(|d| d.severity == Severity::Error) && !parsed.fatal_error {
        errors.extend(SemanticBuilder::new().with_check_syntax_error(true).build(&parsed.program).diagnostics.into_vec());
    }
    errors.retain(|d| d.severity == Severity::Error);
    let mut out = diagnostics::convert(&text, sourcefile, errors);
    for diagnostic in &mut out {
        diagnostic.line = diagnostic.line.saturating_sub(1);
    }
    out
}

/// The automatic runtime falls back to `createElement` for a key after a
/// spread; in development Oxc gives that call `__self` and `__source` props
/// (its jsx self and source plugins, which development turns on for jsxDEV's
/// arguments too), where esbuild passes the props alone. They are taken out.
fn strip_dev_fallback_props(program: &mut Program<'_>, import_source: &str) {
    use oxc::ast::ast::{Argument, Expression, ImportDeclarationSpecifier, ObjectPropertyKind};
    use oxc::ast_visit::{VisitMut, walk_mut};
    let local = program.body.iter().find_map(|statement| match statement {
        Statement::ImportDeclaration(d) if d.source.value.as_str() == import_source => {
            d.specifiers.as_ref()?.iter().find_map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(s) if s.imported.name().as_str() == "createElement" => {
                    Some(s.local.name.to_string())
                }
                _ => None,
            })
        }
        _ => None,
    });
    let Some(local) = local else { return };
    struct Strip(String);
    impl<'a> VisitMut<'a> for Strip {
        fn visit_call_expression(&mut self, call: &mut oxc::ast::ast::CallExpression<'a>) {
            if let Expression::Identifier(callee) = &call.callee
                && callee.name.as_str() == self.0
                && let Some(Argument::ObjectExpression(props)) = call.arguments.get_mut(1)
            {
                props.properties.retain(|p| {
                    !matches!(p, ObjectPropertyKind::ObjectProperty(p) if matches!(p.key.static_name().as_deref(), Some("__self" | "__source")))
                });
            }
            walk_mut::walk_call_expression(self, call);
        }
    }
    Strip(local).visit_program(program);
}

/// Puts a constant fragment where the classic runtime's transform named it
/// by its placeholder (see `transform`).
struct ConstantFragment<'a, 'o> {
    allocator: &'a Allocator,
    name: &'o str,
    constant: &'o options::Constant,
}

impl<'a> oxc::ast_visit::VisitMut<'a> for ConstantFragment<'a, '_> {
    fn visit_expression(&mut self, expr: &mut oxc::ast::ast::Expression<'a>) {
        use oxc::ast::ast::{Expression, NumberBase};
        use oxc::syntax::operator::UnaryOperator;
        use options::Constant;
        if let Expression::Identifier(id) = expr
            && id.name.as_str() == self.name
        {
            let span = id.span;
            let ast = &oxc::ast::builder::AstBuilder::new(self.allocator);
            *expr = match self.constant {
                Constant::Null => Expression::new_null_literal(span, ast),
                Constant::Bool(value) => Expression::new_boolean_literal(span, *value, ast),
                Constant::Number(value) if value.is_sign_negative() => {
                    let magnitude = Expression::new_numeric_literal(span, -value, None, NumberBase::Decimal, ast);
                    Expression::new_unary_expression(span, UnaryOperator::UnaryNegation, magnitude, ast)
                }
                Constant::Number(value) => Expression::new_numeric_literal(span, *value, None, NumberBase::Decimal, ast),
                Constant::String(value) => Expression::new_string_literal(span, self.allocator.alloc_str(value), None, ast),
            };
            return;
        }
        oxc::ast_visit::walk_mut::walk_expression(self, expr);
    }
}

/// esbuild's `alwaysStrict` for CommonJS output: `"use strict"` first, once.
fn use_strict<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    if program.directives.iter().any(|d| d.directive.as_str() == "use strict") {
        return;
    }
    let ast = oxc::ast::builder::AstBuilder::new(allocator);
    let literal = oxc::ast::ast::StringLiteral::new(Span::default(), "use strict", None, &ast);
    let directive = oxc::ast::ast::Directive::new(Span::default(), literal, "use strict", &ast);
    program.directives.insert(0, directive);
}

fn transform_options(options: &Options, fragment_placeholder: Option<&str>, typescript: bool) -> TransformOptions {
    let jsx = match options.jsx {
        JsxMode::Preserve => JsxOptions { jsx_plugin: false, display_name_plugin: false, ..JsxOptions::disable() },
        JsxMode::Automatic => JsxOptions {
            runtime: JsxRuntime::Automatic,
            display_name_plugin: false,
            import_source: options.jsx_import_source.clone(),
            development: options.jsx_dev,
            ..JsxOptions::default()
        },
        JsxMode::Transform => JsxOptions {
            runtime: JsxRuntime::Classic,
            display_name_plugin: false,
            pragma: options.jsx_factory.clone(),
            pragma_frag: fragment_placeholder.map(str::to_string).or_else(|| options.jsx_fragment.clone()),
            ..JsxOptions::default()
        },
    };
    // The classic factory's import is kept for the JSX that will call it; the
    // automatic runtime and preserved JSX call nothing the file imports, so
    // (as for esbuild) an import of React they leave unused is dropped. An
    // empty pragma names no import.
    let (pragma, pragma_frag) = match options.jsx {
        JsxMode::Transform => (
            options.jsx_factory.clone().unwrap_or_else(|| "React.createElement".into()),
            fragment_placeholder.map(str::to_string).or_else(|| options.jsx_fragment.clone()).unwrap_or_else(|| "React.Fragment".into()),
        ),
        JsxMode::Automatic | JsxMode::Preserve => (String::new(), String::new()),
    };
    TransformOptions {
        typescript: TypeScriptOptions {
            jsx_pragma: pragma.into(),
            jsx_pragma_frag: pragma_frag.into(),
            only_remove_type_imports: options.keep_values,
            // useDefineForClassFields false: a field without an initializer goes.
            remove_class_fields_without_initializer: typescript && options.assign_class_fields,
            ..TypeScriptOptions::default()
        },
        // experimentalDecorators, as tsc lowers them (esbuild's __decorateClass).
        decorator: DecoratorOptions { legacy: typescript && options.experimental_decorators, emit_decorator_metadata: false, ..DecoratorOptions::default() },
        // useDefineForClassFields false: class fields lowered, the public ones
        // assigned (setPublicClassFields), nothing else of ES2022.
        assumptions: CompilerAssumptions { set_public_class_fields: typescript && options.assign_class_fields, ..CompilerAssumptions::default() },
        env: EnvOptions {
            es2022: ES2022Options {
                class_properties: (typescript && options.assign_class_fields).then(|| ClassPropertiesOptions { loose: false }),
                // With them, so a static block still runs between the static fields around it.
                class_static_block: typescript && options.assign_class_fields,
                ..ES2022Options::default()
            },
            ..EnvOptions::default()
        },
        jsx,
        ..TransformOptions::default()
    }
}

fn is_export_statement(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::ExportAllDeclaration(_)
            | Statement::ExportDefaultDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_)
            | Statement::ExportDeclaration(_)
    )
}

/// What `Format::Cjs` reports for top-level await, word for word esbuild's
/// message: the caller recognizes it and lowers the module itself.
pub const TOP_LEVEL_AWAIT_CJS: &str = "Top-level await is currently not supported with the \"cjs\" output format";
