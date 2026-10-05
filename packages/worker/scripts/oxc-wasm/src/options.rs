//! Transform options, and their wire form.
//!
//! The JavaScript side sends options as NUL-separated fields: a key, then its
//! value. `define` repeats, carrying `key\0value` pairs as two fields after
//! its own key. Unknown keys are an error rather than ignored, so a caller
//! that asks for something this engine does not do hears about it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loader {
    Js,
    Jsx,
    Ts,
    Tsx,
}

/// The module format of the output. `Preserve` keeps the module's own syntax;
/// `Esm` additionally wraps a CommonJS module as an ES module's default
/// export; `Cjs` lowers ES module syntax to CommonJS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Preserve,
    Esm,
    Cjs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsxMode {
    /// `React.createElement`, or `jsx_factory` / `jsx_fragment`.
    Transform,
    /// `react/jsx-runtime`.
    Automatic,
    Preserve,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceMapMode {
    None,
    /// Returned beside the code.
    External,
    /// Appended to the code as a data URL.
    Inline,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub loader: Loader,
    pub format: Format,
    pub jsx: JsxMode,
    pub jsx_factory: Option<String>,
    pub jsx_fragment: Option<String>,
    /// The automatic runtime's package (`<it>/jsx-runtime`), when not `react`.
    pub jsx_import_source: Option<String>,
    /// The automatic runtime's development variant: `jsxDEV`, with source locations.
    pub jsx_dev: bool,
    /// TypeScript's `verbatimModuleSyntax` / `preserveValueImports`: an
    /// import is removed only when it is type-only, not when it is unused.
    pub preserve_value_imports: bool,
    /// TypeScript's `alwaysStrict`: CommonJS output begins with `"use strict"`.
    pub always_strict: bool,
    /// The error for a decorator in a TypeScript file (`experimentalDecorators`,
    /// whose output this transform does not produce), naming that field.
    pub refuse_decorators: Option<String>,
    /// The error for a TypeScript class with a public or static field
    /// (`useDefineForClassFields` false), naming the field that asks for it.
    pub refuse_class_fields: Option<String>,
    /// `(expression, replacement)`, applied to unbound globals.
    pub define: Vec<(String, String)>,
    pub sourcemap: SourceMapMode,
    /// The name diagnostics and source maps give the input (`<stdin>` when unset).
    pub sourcefile: Option<String>,
    /// Whether the output keeps `import()`; otherwise it becomes a `require`.
    pub supported_dynamic_import: bool,
    /// Whether the output keeps `import.meta`; otherwise it reads an empty object.
    pub supported_import_meta: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            loader: Loader::Js,
            format: Format::Preserve,
            jsx: JsxMode::Transform,
            jsx_factory: None,
            jsx_fragment: None,
            jsx_import_source: None,
            jsx_dev: false,
            preserve_value_imports: false,
            always_strict: false,
            refuse_decorators: None,
            refuse_class_fields: None,
            define: Vec::new(),
            sourcemap: SourceMapMode::None,
            sourcefile: None,
            supported_dynamic_import: true,
            supported_import_meta: true,
        }
    }
}

impl Options {
    /// Parse the wire form described in the module documentation.
    pub fn decode(wire: &str) -> Result<Self, String> {
        let mut options = Self::default();
        if wire.is_empty() {
            return Ok(options);
        }
        let mut fields = wire.split('\0');
        while let Some(key) = fields.next() {
            let mut value = || fields.next().ok_or_else(|| format!("option {key:?} has no value"));
            match key {
                "loader" => {
                    options.loader = match value()? {
                        "js" => Loader::Js,
                        "jsx" => Loader::Jsx,
                        "ts" => Loader::Ts,
                        "tsx" => Loader::Tsx,
                        other => return Err(format!("unsupported loader {other:?}")),
                    }
                }
                "format" => {
                    options.format = match value()? {
                        "preserve" => Format::Preserve,
                        "esm" => Format::Esm,
                        "cjs" => Format::Cjs,
                        other => return Err(format!("unsupported format {other:?}")),
                    }
                }
                "jsx" => {
                    options.jsx = match value()? {
                        "transform" => JsxMode::Transform,
                        "automatic" => JsxMode::Automatic,
                        "preserve" => JsxMode::Preserve,
                        other => return Err(format!("unsupported jsx mode {other:?}")),
                    }
                }
                "jsxFactory" => options.jsx_factory = Some(value()?.to_string()),
                "jsxFragment" => options.jsx_fragment = Some(value()?.to_string()),
                "jsxImportSource" => options.jsx_import_source = Some(value()?.to_string()),
                "jsxDev" => options.jsx_dev = flag(value()?)?,
                "preserveValueImports" => options.preserve_value_imports = flag(value()?)?,
                "alwaysStrict" => options.always_strict = flag(value()?)?,
                "refuseDecorators" => options.refuse_decorators = Some(value()?.to_string()),
                "refuseClassFields" => options.refuse_class_fields = Some(value()?.to_string()),
                "define" => {
                    let name = value()?.to_string();
                    let replacement = value()?.to_string();
                    options.define.push((name, replacement));
                }
                "sourcemap" => {
                    options.sourcemap = match value()? {
                        "none" => SourceMapMode::None,
                        "external" => SourceMapMode::External,
                        "inline" => SourceMapMode::Inline,
                        other => return Err(format!("unsupported sourcemap mode {other:?}")),
                    }
                }
                "sourcefile" => options.sourcefile = Some(value()?.to_string()),
                "dynamicImport" => options.supported_dynamic_import = flag(value()?)?,
                "importMeta" => options.supported_import_meta = flag(value()?)?,
                other => return Err(format!("unknown option {other:?}")),
            }
        }
        if options.format == Format::Cjs
            && options.jsx == JsxMode::Preserve
            && matches!(options.loader, Loader::Jsx | Loader::Tsx)
        {
            // A preserved `<C />` names an import that CommonJS output moves
            // onto a record; module.rs does not rewrite JSX names.
            return Err("jsx \"preserve\" is not supported with format \"cjs\"".into());
        }
        Ok(options)
    }
}

fn flag(value: &str) -> Result<bool, String> {
    match value {
        "1" => Ok(true),
        "0" => Ok(false),
        other => Err(format!("expected 0 or 1, got {other:?}")),
    }
}
