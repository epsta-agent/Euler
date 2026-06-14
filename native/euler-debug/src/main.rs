//! `euler-debug` binary.
//!
//! Reads one JSON request per line from stdin, dispatches it against an owned
//! [`RpcSession`], and writes one JSON response per line to stdout. Exits on
//! EOF or a fatal read error.
//!
//! Protocol example:
//!
//! ```text
//! {"op":"start","target":"main.py"}
//! {"ok":true,"result":{"started":true,"adapter":"python","state":"initialized"}}
//! {"op":"disconnect","terminate":true}
//! {"ok":true,"result":{"terminated":true}}
//! ```

use std::io::{self, BufRead, Write};

use euler_debug::rpc::{RpcRequest, RpcResponse, RpcSession};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let mut session = RpcSession::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(out, "{}", serde_json::to_string(&RpcResponse::err(format!("read error: {e}"))).unwrap_or_default());
                break;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<RpcRequest>(trimmed) {
            Ok(req) => match session.handle(req) {
                Ok(value) => RpcResponse::ok(value),
                Err(e) => RpcResponse::err(e.0),
            },
            Err(e) => RpcResponse::err(format!("invalid request: {e}")),
        };

        // Serialize is infallible for our struct, but guard anyway.
        match serde_json::to_string(&response) {
            Ok(s) => {
                let _ = writeln!(out, "{s}");
                let _ = out.flush();
            }
            Err(e) => {
                let _ = writeln!(out, "{{\"ok\":false,\"error\":\"encode error: {e}\"}}");
                let _ = out.flush();
            }
        }
    }

    // Session drops here, which kills any live adapter child.
}
