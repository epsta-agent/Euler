//! euler-debug: a Rust-native DAP (Debug Adapter Protocol) bridge.
//!
//! This crate provides a stable, junior-friendly line-delimited JSON RPC
//! surface (see [`rpc`]) that the Euler agent talks to over stdio. Under the
//! hood it drives *real* DAP adapters (debugpy, lldb-dap/codelldb, dlv, node)
//! using the actual DAP Content-Length framing — there are no mocks.
//!
//! Module layout:
//! - [`protocol`]: DAP JSON-RPC framing (read/write of DAP messages).
//! - [`adapter`]: adapter detection from target language + spawn helpers.
//! - [`client`]: `DebugClient` owning one live DAP session and its state.
//! - [`rpc`]: the line-JSON request/response protocol the binary exposes.
//! - [`bin`]: the `euler-debug` binary (see `src/main.rs`).

pub mod adapter;
pub mod client;
pub mod protocol;
pub mod rpc;

pub use adapter::{detect_adapter, AdapterKind, AdapterSpec};
pub use client::{Breakpoint, DebugClient, DebugState, Scope, StackFrame, Thread, Variable};
pub use protocol::{DapError, DapTransport};
pub use rpc::{RpcError, RpcRequest, RpcResponse, RpcResult, RpcSession};
