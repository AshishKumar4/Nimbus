fn main() {
  // Emits the emnapi link line (the non-threaded `emnapi-basic-napi-rs`
  // archive for wasm32-wasip1), the reactor startup object and the napi
  // exports the loader drives. EMNAPI_LINK_DIR is set by ../../build.mjs.
  napi_build::setup();
}
