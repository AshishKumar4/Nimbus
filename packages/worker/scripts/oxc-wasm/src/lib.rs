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
    if source_type.is_typescript()
        && (options.refuse_decorators.is_some() || options.refuse_class_fields.is_some())
        && let Some(error) = refused(&parsed.program, options)
    {
        return Output::failed(diagnostics::convert(source, sourcefile, vec![error]));
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
        let transform_options = transform_options(options, fragment.as_ref().map(|(name, _)| name.as_str()));
        let transformed = Transformer::new(allocator, std::path::Path::new(sourcefile), &transform_options)
            .build_with_scoping(scoping, &mut program);
        if transformed.diagnostics.has_errors() {
            return Output::failed(diagnostics::convert(source, sourcefile, transformed.diagnostics.into_vec()));
        }
        scoping = transformed.scoping;
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

/// The first decorator or class field a TypeScript file's tsconfig makes this
/// transform refuse (options.rs: `refuse_decorators`, `refuse_class_fields`),
/// as an error at it carrying the refusal. A class's private fields alone
/// stay fields under esbuild too; one public or static field moves them all.
fn refused(program: &Program<'_>, options: &Options) -> Option<OxcDiagnostic> {
    use oxc::ast::ast::{Decorator, PropertyDefinition, PropertyDefinitionType};
    use oxc::ast_visit::{Visit, walk};

    struct Find<'o> {
        decorators: Option<&'o str>,
        class_fields: Option<&'o str>,
        found: Option<(Span, &'o str)>,
    }
    impl<'a> Visit<'a> for Find<'_> {
        fn visit_decorator(&mut self, it: &Decorator<'a>) {
            if let (None, Some(text)) = (self.found, self.decorators) {
                self.found = Some((it.span, text));
            }
        }
        fn visit_property_definition(&mut self, it: &PropertyDefinition<'a>) {
            if let (None, Some(text)) = (self.found, self.class_fields)
                && it.r#type == PropertyDefinitionType::PropertyDefinition
                && !it.declare
                && !it.key.is_private_identifier()
            {
                self.found = Some((it.span, text));
            }
            walk::walk_property_definition(self, it);
        }
    }
    let mut find = Find {
        decorators: options.refuse_decorators.as_deref(),
        class_fields: options.refuse_class_fields.as_deref(),
        found: None,
    };
    find.visit_program(program);
    find.found.map(|(span, text)| OxcDiagnostic::error(text.to_string()).with_label(span))
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
            Statement::ImportDeclaration(d) => Some(d.span.start),
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

fn transform_options(options: &Options, fragment_placeholder: Option<&str>) -> TransformOptions {
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
            ..TypeScriptOptions::default()
        },
        jsx,
        env: EnvOptions::default(),
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
