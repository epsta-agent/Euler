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
//!
//! Logging: the protocol lives on stdout, so log records go to **stderr** and
//! are silent unless `EULER_DEBUG_LOG` is set (to `trace`, `debug`, `info`,
//! `warn`, or `error`). This keeps the agent's stdout stream pure JSON while
//! still letting a human diagnose adapter failures.

use std::io::{self, BufRead, Write};

use euler_debug::rpc::{RpcRequest, RpcResponse, RpcSession};

fn main() {
    init_logging();
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

/// Install a minimal `log` logger that writes to **stderr** (never stdout,
/// which carries the JSON protocol). Activation is opt-in via the
/// `EULER_DEBUG_LOG` env var so the binary is silent by default — important
/// because the agent process parses stdout line-by-line and any stray log
/// output there would corrupt the protocol.
///
/// We hand-roll this (rather than pulling in `env_logger`) to keep the
/// dependency surface of this binary minimal; it is ~20 lines.
fn init_logging() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let level = std::env::var("EULER_DEBUG_LOG").ok().and_then(|raw| {
            let raw = raw.trim().to_ascii_lowercase();
            match raw.as_str() {
                "off" => Some(log::LevelFilter::Off),
                "error" => Some(log::LevelFilter::Error),
                "warn" => Some(log::LevelFilter::Warn),
                "info" => Some(log::LevelFilter::Info),
                "debug" => Some(log::LevelFilter::Debug),
                "trace" => Some(log::LevelFilter::Trace),
                _ => None,
            }
        });
        // Default to Off so stdout stays pure; flip on only if asked.
        let max = level.unwrap_or(log::LevelFilter::Off);
        log::set_max_level(max);
        let result = log::set_logger(&STDERR_LOGGER);
        // set_logger can only fail if called twice; INIT guards against that.
        debug_assert!(result.is_ok(), "log::set_logger called twice");
    });
}

/// The single static logger instance. Routes records to stderr with a
/// `euler-debug: <LEVEL> <message>` prefix.
static STDERR_LOGGER: StderrLogger = StderrLogger;

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // stderr is not part of the JSON protocol; safe to write here. Ignore
        // errors (stderr closed is not actionable).
        let _ = writeln!(
            io::stderr(),
            "euler-debug: {} {}",
            record.level(),
            record.args()
        );
    }

    fn flush(&self) {}
}
