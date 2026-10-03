//! Diagnostics in the shape esbuild reports them: text plus a location whose
//! line is 1-based and whose column is a 0-based byte offset into the line.

use oxc::diagnostics::{OxcDiagnostic, Severity};

pub struct Diagnostic {
    pub error: bool,
    pub text: String,
    pub file: String,
    /// 0 when the diagnostic has no location.
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub line_text: String,
}

pub fn convert(source: &str, file: &str, diagnostics: Vec<OxcDiagnostic>) -> Vec<Diagnostic> {
    diagnostics
        .into_iter()
        .filter(|d| matches!(d.severity, Severity::Error | Severity::Warning))
        .map(|d| {
            let mut text = d.message.to_string();
            if let Some(help) = &d.help {
                text.push_str(" (");
                text.push_str(help);
                text.push(')');
            }
            let mut diagnostic = Diagnostic {
                error: d.severity == Severity::Error,
                text,
                file: file.to_string(),
                line: 0,
                column: 0,
                length: 0,
                line_text: String::new(),
            };
            if let Some(label) = d.labels.first() {
                let offset = (label.offset() as usize).min(source.len());
                let line_start = source[..offset].rfind(['\n', '\r']).map_or(0, |i| i + 1);
                let line_end = source[offset..].find(['\n', '\r']).map_or(source.len(), |i| offset + i);
                diagnostic.line = 1 + source[..line_start].bytes().filter(|&b| b == b'\n').count() as u32;
                diagnostic.column = (offset - line_start) as u32;
                diagnostic.length = label.span().size().min((line_end - offset) as u32);
                diagnostic.line_text = source[line_start..line_end].to_string();
            }
            diagnostic
        })
        .collect()
}
