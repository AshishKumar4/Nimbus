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
        let transform_options = transform_options(options);
        let transformed = Transformer::new(allocator, std::path::Path::new(sourcefile), &transform_options)
            .build_with_scoping(scoping, &mut program);
        if transformed.diagnostics.has_errors() {
            return Output::failed(diagnostics::convert(source, sourcefile, transformed.diagnostics.into_vec()));
        }
        scoping = transformed.scoping;
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

fn transform_options(options: &Options) -> TransformOptions {
    let jsx = match options.jsx {
        JsxMode::Preserve => JsxOptions { jsx_plugin: false, display_name_plugin: false, ..JsxOptions::disable() },
        JsxMode::Automatic => JsxOptions {
            runtime: JsxRuntime::Automatic,
            display_name_plugin: false,
            ..JsxOptions::default()
        },
        JsxMode::Transform => JsxOptions {
            runtime: JsxRuntime::Classic,
            display_name_plugin: false,
            pragma: options.jsx_factory.clone(),
            pragma_frag: options.jsx_fragment.clone(),
            ..JsxOptions::default()
        },
    };
    TransformOptions {
        typescript: TypeScriptOptions {
            jsx_pragma: options.jsx_factory.clone().map(Into::into).unwrap_or_else(|| "React.createElement".into()),
            jsx_pragma_frag: options.jsx_fragment.clone().map(Into::into).unwrap_or_else(|| "React.Fragment".into()),
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
