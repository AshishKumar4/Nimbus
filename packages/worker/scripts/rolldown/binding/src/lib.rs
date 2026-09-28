//! Rolldown's N-API binding for a host with one thread and an event loop.
//!
//! Upstream builds its wasm binding for `wasm32-wasip1-threads`: tokio's
//! multi-thread runtime on wasi threads over shared memory. A Cloudflare
//! Worker isolate has one thread and no `Atomics.wait`, so this build targets
//! plain `wasm32-wasip1` and supplies the async runtime upstream leaves to the
//! embedder there (napi-rs's `async-runtime` SPI):
//!
//! - Every `#[napi] async fn` future (and every task rolldown `tokio::spawn`s
//!   under it) runs on one tokio current-thread runtime owned here.
//! - The host drives that runtime: `nimbus_rolldown_pump` runs runnable tasks
//!   until none is left (or a poll budget is spent) and returns. It never
//!   parks, so it never blocks the event loop waiting for JavaScript.
//! - A task that awaits JavaScript (a plugin hook, a promise) is woken from a
//!   napi callback the host makes later; the host pumps again after such
//!   callbacks while tasks are alive. New work asks for a pump through the
//!   `nimbus_rolldown.request_pump` import.
//!
//! Nothing here changes rolldown's behavior; it replaces the threads the
//! upstream wasm build schedules on with turns of the host's event loop.

#[cfg(any(not(target_os = "wasi"), target_feature = "atomics"))]
compile_error!("nimbus_rolldown_binding is the threadless wasm32-wasip1 build; use upstream for every other target");

// Links every upstream `#[napi]` registration symbol into this cdylib.
extern crate rolldown_binding;

use std::{
  future::{Future, poll_fn},
  pin::Pin,
  sync::{
    LazyLock,
    atomic::{AtomicU64, Ordering},
  },
  task::Poll,
};

use napi::bindgen_prelude::{
  AsyncRuntime, AsyncRuntimeGuard, AsyncRuntimeRejection, AsyncRuntimeTask, register_async_runtime,
};

#[link(wasm_import_module = "nimbus_rolldown")]
unsafe extern "C" {
  /// Ask the host for a pump on a later turn. Idempotent until it runs.
  #[link_name = "request_pump"]
  safe fn host_request_pump();
}

/// Task polls since load; the pump reads it to tell a turn that ran work
/// from one that found the runtime idle.
static TASK_POLLS: AtomicU64 = AtomicU64::new(0);

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
  tokio::runtime::Builder::new_current_thread()
    .enable_time()
    .on_before_task_poll(|_| {
      TASK_POLLS.fetch_add(1, Ordering::Relaxed);
    })
    .build()
    .expect("nimbus: failed to build rolldown's current-thread tokio runtime")
});

fn runtime() -> &'static tokio::runtime::Runtime {
  &RUNTIME
}

struct EventLoopRuntime;

struct Entered(#[allow(dead_code)] tokio::runtime::EnterGuard<'static>);

impl AsyncRuntimeGuard for Entered {}

// SAFETY: the backend owns no thread and no image-external callback; tasks
// live in the process-global runtime, which lives as long as the instance.
unsafe impl AsyncRuntime for EventLoopRuntime {
  fn spawn(
    &self,
    task: AsyncRuntimeTask,
  ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
    // Detached: the task settles its own promise. Scheduled from outside the
    // runtime, it waits in the inject queue until the host pumps.
    drop(runtime().spawn(task));
    host_request_pump();
    Ok(())
  }

  fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> napi::Result<()> {
    // Only napi's synchronous helpers reach this. A future that waits on
    // JavaScript cannot finish here (the host's turn never comes), and tokio
    // then traps on the unsupported park instead of hanging the isolate.
    runtime().block_on(future);
    Ok(())
  }

  fn enter(&self) -> napi::Result<Box<dyn AsyncRuntimeGuard + '_>> {
    Ok(Box::new(Entered(runtime().enter())))
  }

  fn shutdown(&self) -> napi::Result<()> {
    Ok(())
  }
}

#[napi_derive::module_init]
fn register_event_loop_runtime() {
  register_async_runtime(EventLoopRuntime);
}

/// Run runnable tasks until none is left or `budget` task polls have run.
///
/// Returns `alive << 1 | exhausted`: `exhausted` means work is still runnable
/// (pump again on a later turn); `alive` counts tasks not yet finished, which
/// are waiting on JavaScript or a timer when `exhausted` is clear.
///
/// The `block_on` future wakes itself on every poll, so tokio never parks the
/// thread: an idle scheduler polls its timer driver with a zero timeout and
/// comes straight back. The future finishes after three consecutive polls in
/// which no task ran — a run phase, a driver poll, and a run phase for
/// whatever that driver poll woke.
#[unsafe(no_mangle)]
pub extern "C" fn nimbus_rolldown_pump(budget: u32) -> u32 {
  let rt = runtime();
  let start = TASK_POLLS.load(Ordering::Relaxed);
  let mut last = start;
  let mut idle_polls = 0u32;
  let mut exhausted = false;
  rt.block_on(poll_fn(|cx| {
    let now = TASK_POLLS.load(Ordering::Relaxed);
    if now == last {
      idle_polls += 1;
    } else {
      last = now;
      idle_polls = 0;
    }
    if now.wrapping_sub(start) >= u64::from(budget) {
      exhausted = true;
      return Poll::Ready(());
    }
    if idle_polls >= 3 {
      return Poll::Ready(());
    }
    cx.waker().wake_by_ref();
    Poll::Pending
  }));
  let alive = u32::try_from(rt.metrics().num_alive_tasks()).unwrap_or(u32::MAX).min(u32::MAX >> 1);
  (alive << 1) | u32::from(exhausted)
}

/// Tasks not yet finished. The host pumps after a napi callback only when
/// this is nonzero: a callback can only wake a task that exists.
#[unsafe(no_mangle)]
pub extern "C" fn nimbus_rolldown_alive_tasks() -> u32 {
  LazyLock::get(&RUNTIME)
    .map_or(0, |rt| u32::try_from(rt.metrics().num_alive_tasks()).unwrap_or(u32::MAX))
}
