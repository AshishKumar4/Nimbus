//! `cargo run --release --example memory -- <file> [key=value ...]`: peak heap of one transform.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use oxc::allocator::Allocator;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
        PEAK.fetch_max(live, Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let live = LIVE.fetch_add(new_size, Relaxed) + new_size;
        PEAK.fetch_max(live, Relaxed);
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a file");
    let source = std::fs::read_to_string(&path).expect("readable file");
    let wire: Vec<String> = args.flat_map(|a| a.splitn(2, '=').map(str::to_string).collect::<Vec<_>>()).collect();
    let options = nimbus_oxc::options::Options::decode(&wire.join("\0")).expect("options");
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let allocator = Allocator::default();
    let started = std::time::Instant::now();
    let output = nimbus_oxc::transform(&allocator, &source, &options);
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let arena = allocator.capacity();
    let mib = |b: usize| b as f64 / 1048576.0;
    eprintln!(
        "source {:.2} MiB, output {:.2} MiB, arena {:.2} MiB (used {:.2}), peak heap over base {:.2} MiB, {:.1} ms, errors {}",
        mib(source.len()), mib(output.code.len()), mib(arena), mib(allocator.used_bytes()), mib(PEAK.load(Relaxed) - base), ms,
        output.diagnostics.iter().filter(|d| d.error).count()
    );
}
