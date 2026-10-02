//! The wasm32 interface. The module imports nothing; JavaScript drives it
//! through four exports:
//!
//! 1. `nimbus_oxc_alloc(capacity)` returns a buffer, into which the caller
//!    writes the UTF-8 source followed by the options' wire form (options.rs).
//!    `nimbus_oxc_realloc(ptr, capacity, new_capacity)` grows it, for a source
//!    whose UTF-8 is longer than the caller first guessed.
//! 2. `nimbus_oxc_transform(ptr, capacity, source_len, options_len)` consumes
//!    that buffer and returns the address of nine `u32`s: status (0 ok, 1 the
//!    module was refused, 2 the options were), then the address and length of
//!    the code, of the source map JSON, and of the diagnostics, then the bytes
//!    of AST arena the transform used and reserved.
//! 3. The caller copies what it needs, then calls `nimbus_oxc_release()`,
//!    which frees the outputs. Nothing is kept between transforms, so the
//!    arena a large module needed is reused for the next module's arena and
//!    everything else.
//!
//! Diagnostics are seven fields per diagnostic: `E` or `W`, line, column,
//! length, file, line text, message. Each field is its UTF-8 byte length in
//! decimal, `:`, then its bytes, so a field may hold any character (a source
//! line can hold a NUL).

use std::alloc::{Layout, alloc, dealloc, realloc};
use std::fmt::Write;

use oxc::allocator::Allocator;

use crate::options::Options;

struct Result {
    words: [u32; 9],
    code: String,
    map: String,
    diagnostics: String,
}

static mut RESULT: Option<Result> = None;

#[unsafe(no_mangle)]
pub extern "C" fn nimbus_oxc_alloc(capacity: usize) -> *mut u8 {
    // SAFETY: the size is nonzero and the layout's alignment is 1.
    unsafe { alloc(Layout::from_size_align_unchecked(capacity.max(1), 1)) }
}

/// # Safety
/// `ptr` came from `nimbus_oxc_alloc(capacity)` (or this function with that capacity).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nimbus_oxc_realloc(ptr: *mut u8, capacity: usize, new_capacity: usize) -> *mut u8 {
    // SAFETY: as documented; the layout matches the allocation's.
    unsafe { realloc(ptr, Layout::from_size_align_unchecked(capacity.max(1), 1), new_capacity.max(1)) }
}

/// # Safety
/// `ptr` came from `nimbus_oxc_alloc(capacity)` and its first
/// `source_len + options_len` bytes are written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nimbus_oxc_transform(
    ptr: *mut u8,
    capacity: usize,
    source_len: usize,
    options_len: usize,
) -> *const u32 {
    // SAFETY: the caller wrote these bytes at `ptr`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, source_len + options_len) };
    let result = run(&bytes[..source_len], &bytes[source_len..]);
    // SAFETY: allocated by `nimbus_oxc_alloc(capacity)`.
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(capacity.max(1), 1)) };
    // SAFETY: wasm32 here is single-threaded; nothing else holds a reference to RESULT.
    unsafe {
        let slot = &mut *std::ptr::addr_of_mut!(RESULT);
        let result = slot.insert(result);
        result.words[1] = result.code.as_ptr() as u32;
        result.words[2] = result.code.len() as u32;
        result.words[3] = result.map.as_ptr() as u32;
        result.words[4] = result.map.len() as u32;
        result.words[5] = result.diagnostics.as_ptr() as u32;
        result.words[6] = result.diagnostics.len() as u32;
        result.words.as_ptr()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nimbus_oxc_release() {
    // SAFETY: as in `nimbus_oxc_transform`.
    unsafe { *std::ptr::addr_of_mut!(RESULT) = None };
}

fn run(source: &[u8], options: &[u8]) -> Result {
    let refused = |status: u32, message: String| Result {
        words: [status, 0, 0, 0, 0, 0, 0, 0, 0],
        code: String::new(),
        map: String::new(),
        diagnostics: diagnostic_fields(['E'.to_string(), "0".into(), "0".into(), "0".into(), "<stdin>".into(), String::new(), message]),
    };
    let Ok(source) = std::str::from_utf8(source) else {
        return refused(1, "the source is not UTF-8".into());
    };
    let options = match std::str::from_utf8(options).map_err(|e| e.to_string()).and_then(Options::decode) {
        Ok(options) => options,
        Err(message) => return refused(2, message),
    };
    let allocator = Allocator::default();
    let output = crate::transform(&allocator, source, &options);
    let arena = [allocator.used_bytes() as u32, allocator.capacity() as u32];
    drop(allocator);
    let diagnostics = output
        .diagnostics
        .iter()
        .map(|d| {
            diagnostic_fields([
                if d.error { "E" } else { "W" }.to_string(),
                d.line.to_string(),
                d.column.to_string(),
                d.length.to_string(),
                d.file.clone(),
                d.line_text.clone(),
                d.text.clone(),
            ])
        })
        .collect();
    Result {
        words: [u32::from(output.has_errors()), 0, 0, 0, 0, 0, 0, arena[0], arena[1]],
        code: output.code,
        map: output.map.unwrap_or_default(),
        diagnostics,
    }
}

/// One diagnostic's fields, each as `<byte length>:<bytes>`.
fn diagnostic_fields(fields: [String; 7]) -> String {
    let mut out = String::new();
    for field in fields {
        let _ = write!(out, "{}:{field}", field.len());
    }
    out
}
