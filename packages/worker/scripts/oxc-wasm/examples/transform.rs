//! `cargo run --example transform -- <file> [key=value ...]`: print one transform.
use oxc::allocator::Allocator;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a file");
    let source = std::fs::read_to_string(&path).expect("readable file");
    // key=value; define=name=replacement
    let wire: Vec<String> = args.flat_map(|a| a.splitn(if a.starts_with("define=") { 3 } else { 2 }, '=').map(str::to_string).collect::<Vec<_>>()).collect();
    let options = nimbus_oxc::options::Options::decode(&wire.join("\0")).expect("options");
    let allocator = Allocator::default();
    let output = nimbus_oxc::transform(&allocator, &source, &options);
    for d in &output.diagnostics {
        eprintln!("{} {}:{}:{}: {}", if d.error { "ERROR" } else { "WARN" }, d.file, d.line, d.column, d.text);
    }
    print!("{}", output.code);
    if let Some(map) = output.map {
        eprintln!("MAP {map}");
    }
}
