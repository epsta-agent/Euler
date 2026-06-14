//! High-level DAP client.
//!
//! [`DebugClient`] owns one live DAP session: the adapter transport, the next
//! outbound sequence number, and the latest session state (initialized flag,
//! threads, current stack/variables). Each high-level command returns plain
//! Rust structs so callers never have to touch raw DAP JSON.
//!
//! The client is synchronous: each command sends a request and reads messages
//! until the matching response arrives (forwarding asynchronous `event` and
//! unrelated `response` messages to an optional handler). This keeps the
//! junior-facing surface dead simple: one call == one answer.

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::adapter::{self, AdapterKind, AdapterSpec};
use crate::protocol::{DapError, DapTransport};

/// Default per-request timeout. DAP adapters are usually fast, but launches of
/// large programs can take a few seconds.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Coarse state of the debugged program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugState {
    /// Not yet launched / attached.
    Idle,
    /// Adapter initialized and ready.
    Initialized,
    /// Program is running.
    Running,
    /// Program is paused at a breakpoint or after a step.
    Stopped,
    /// Program terminated.
    Terminated,
}

impl DebugState {
    pub fn as_str(&self) -> &'static str {
        match self {
            DebugState::Idle => "idle",
            DebugState::Initialized => "initialized",
            DebugState::Running => "running",
            DebugState::Stopped => "stopped",
            DebugState::Terminated => "terminated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub name: String,
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
    pub expensive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none", default)]
    pub r#type: Option<String>,
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub verified: bool,
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub source: Option<String>,
    pub line: i64,
    pub column: i64,
}

/// Concrete transport type used by [`DebugClient`]. The reader slot is a
/// [`NullReader`] placeholder because the real adapter reader is moved into a
/// dedicated background thread (see [`DebugClient::launch_with_spec`]); the
/// client only ever uses the writer half of this transport.
pub type ClientTransport = DapTransport<NullReader, Box<dyn std::io::Write + Send + 'static>>;

/// A live DAP debug session.
pub struct DebugClient {
    transport: ClientTransport,
    child: Option<Child>,
    /// Messages read by the dedicated reader thread. `None` once the reader
    /// has terminated (EOF or error).
    incoming: Option<mpsc::Receiver<Result<Value, DapError>>>,
    seq: AtomicU64,
    adapter_kind: AdapterKind,
    state: DebugState,
    /// Most-recent variablesReference per named scope, so callers can ask for
    /// "locals"/"arguments" by name after a stackTrace.
    scopes: HashMap<i64, Vec<Scope>>,
}

impl DebugClient {
    /// Spawn the adapter detected for `target` and send `initialize`.
    pub fn launch(target: &str, force_adapter: Option<&str>) -> Result<Self, String> {
        let spec = adapter::detect_adapter(target, force_adapter)?;
        Self::launch_with_spec(&spec)
    }

    /// Launch using an explicit [`AdapterSpec`]. Useful for tests.
    pub fn launch_with_spec(spec: &AdapterSpec) -> Result<Self, String> {
        let mut child = adapter::spawn_adapter(spec)?;
        let stdout: Box<dyn std::io::Read + Send + 'static> =
            Box::new(child.stdout.take().expect("adapter stdout piped"));
        let stdin: Box<dyn std::io::Write + Send + 'static> =
            Box::new(child.stdin.take().expect("adapter stdin piped"));

        // Split the transport: the reader goes to a dedicated background thread
        // that pumps messages into a channel; the writer stays here so we can
        // send requests. This avoids any read/write lock contention and makes
        // timeouts clean (the reader thread lives for the whole session).
        let reader = std::io::BufReader::new(stdout);
        let writer = stdin;
        let (tx, rx) = mpsc::channel::<Result<Value, DapError>>();
        std::thread::spawn(move || {
            let mut reader = reader;
            loop {
                match read_message_from(&mut reader) {
                    Ok(msg) => {
                        if tx.send(Ok(msg)).is_err() {
                            // Receiver dropped: session is done.
                            break;
                        }
                    }
                    Err(DapError::Eof) => {
                        let _ = tx.send(Err(DapError::Eof));
                        break;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        break;
                    }
                }
            }
        });

        let transport = DapTransport::new(NullReader, writer);

        let mut client = Self {
            transport,
            child: Some(child),
            incoming: Some(rx),
            seq: AtomicU64::new(1),
            adapter_kind: spec.kind,
            state: DebugState::Idle,
            scopes: HashMap::with_capacity(8),
        };

        client.initialize()?;
        Ok(client)
    }

    pub fn adapter_kind(&self) -> AdapterKind {
        self.adapter_kind
    }

    pub fn state(&self) -> DebugState {
        self.state
    }

    fn next_seq(&self) -> i64 {
        // Single-threaded access (the main loop); Relaxed is sufficient and
        // avoids the fence SeqCst would impose on every request.
        self.seq.fetch_add(1, Ordering::Relaxed) as i64
    }

    // -- low-level request/response machinery --------------------------------

    /// Send a DAP request and block until the matching response arrives.
    ///
    /// While waiting, any `event` messages update internal state (e.g. a
    /// `stopped` event flips the state to `Stopped`).
    fn request(&mut self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.next_seq();
        let request = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        self.transport
            .send_message(&request)
            .map_err(|e| format!("failed to send {command}: {e}"))?;

        let deadline = Instant::now() + DEFAULT_TIMEOUT;
        loop {
            let msg = self.read_next(deadline)?;
            let msg_seq = msg.get("request_seq").and_then(|v| v.as_i64());
            if msg.get("type") == Some(&Value::String("response".into()))
                && msg_seq == Some(seq)
            {
                if msg.get("success") == Some(&Value::Bool(false)) {
                    let err = msg
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(no message)");
                    return Err(format!("adapter rejected '{command}': {err}"));
                }
                return Ok(msg);
            }
            self.handle_async(&msg);
        }
    }

    /// Send a request and return when EITHER the matching response arrives OR
    /// the named event arrives (whichever comes first). Used for `launch` and
    /// `attach`, where some adapters defer their response until later setup is
    /// done but emit an `initialized` event immediately.
    fn request_or_event(
        &mut self,
        arguments: &Value,
        command: &str,
        event: &str,
    ) -> Result<(), String> {
        let seq = self.next_seq();
        let request = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        self.transport
            .send_message(&request)
            .map_err(|e| format!("failed to send {command}: {e}"))?;

        let deadline = Instant::now() + DEFAULT_TIMEOUT;
        loop {
            let msg = self.read_next(deadline)?;
            let msg_seq = msg.get("request_seq").and_then(|v| v.as_i64());

            // Matching response: success completes, failure aborts.
            if msg.get("type") == Some(&Value::String("response".into()))
                && msg_seq == Some(seq)
            {
                if msg.get("success") == Some(&Value::Bool(false)) {
                    let err = msg
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(no message)");
                    return Err(format!("adapter rejected '{command}': {err}"));
                }
                return Ok(());
            }

            // Watched event: completes successfully.
            if msg.get("type") == Some(&Value::String("event".into()))
                && msg.get("event").and_then(|v| v.as_str()) == Some(event)
            {
                self.handle_async(&msg);
                return Ok(());
            }

            // A `terminated`/`exited` event during launch is a real error.
            if msg.get("type") == Some(&Value::String("event".into())) {
                let ev = msg.get("event").and_then(|v| v.as_str()).unwrap_or("");
                if ev == "terminated" || ev == "exited" {
                    return Err(format!("{command}: debuggee terminated during startup"));
                }
            }

            self.handle_async(&msg);
        }
    }

    /// Read one message from the incoming channel, honoring a deadline.
    fn read_next(&mut self, deadline: Instant) -> Result<Value, String> {
        let rx = match self.incoming.as_mut() {
            Some(rx) => rx,
            None => return Err("adapter reader is closed".to_string()),
        };
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "timed out waiting for adapter message".to_string())?;
        match rx.recv_timeout(remaining) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(DapError::Eof)) => {
                // Reader thread ended; drain channel and mark closed.
                self.incoming = None;
                Err("adapter closed the connection".to_string())
            }
            Ok(Err(e)) => {
                self.incoming = None;
                Err(format!("read error: {e}"))
            }
            Err(RecvTimeoutError::Timeout) => {
                Err("timed out waiting for adapter message".to_string())
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.incoming = None;
                Err("reader thread terminated".to_string())
            }
        }
    }

    /// Update internal state from asynchronous DAP messages.
    fn handle_async(&mut self, msg: &Value) {
        if msg.get("type") != Some(&Value::String("event".into())) {
            return;
        }
        let event = msg.get("event").and_then(|v| v.as_str()).unwrap_or("");
        match event {
            "initialized" => self.state = DebugState::Initialized,
            "stopped" => self.state = DebugState::Stopped,
            "terminated" | "exited" => self.state = DebugState::Terminated,
            "continued" => self.state = DebugState::Running,
            _ => {}
        }
    }

    // -- DAP commands --------------------------------------------------------

    /// `initialize` handshake.
    pub fn initialize(&mut self) -> Result<(), String> {
        let args = json!({
            "clientID": "euler-debug",
            "clientName": "Euler Agent",
            "adapterID": self.adapter_kind.as_str(),
            "locale": "en-US",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsRunInTerminalRequest": false,
        });
        self.request("initialize", args)?;
        Ok(())
    }

    /// `launch` with a program and optional args. The exact `launch` payload
    /// is adapter-specific, so we build it per-kind.
    pub fn launch_program(&mut self, program: &str, args: &[String]) -> Result<(), String> {
        let arguments = build_launch_arguments(self.adapter_kind, program, args);
        // Some adapters (notably debugpy) only send the `launch` *response*
        // AFTER the client has sent `configurationDone`. They DO send an
        // `initialized` event promptly, so we treat that (or the response,
        // whichever comes first) as the launch-complete signal. This keeps
        // the flow working across debugpy, lldb-dap, dlv, and node.
        self.request_or_event(&arguments, "launch", "initialized")?;
        Ok(())
    }

    /// `attach` to a running PID (best-effort, adapter-dependent).
    pub fn attach(&mut self, pid: u32) -> Result<(), String> {
        let arguments = match self.adapter_kind {
            AdapterKind::Lldb => json!({ "pid": pid, "stopOnEntry": false }),
            AdapterKind::Python => json!({ "connect": { "host": "127.0.0.1", "port": 0 } }),
            AdapterKind::Go => json!({ "mode": "local", "processId": pid }),
            AdapterKind::Node => json!({ "processId": pid }),
        };
        self.request_or_event(&arguments, "attach", "initialized")?;
        Ok(())
    }

    /// `setBreakpoints` in a single source file.
    pub fn set_breakpoints(
        &mut self,
        source: &str,
        lines: &[(i64, Option<String>)],
    ) -> Result<Vec<Breakpoint>, String> {
        let bps: Vec<Value> = lines
            .iter()
            .map(|(line, cond)| {
                let mut o = json!({ "line": line });
                if let Some(c) = cond {
                    o["condition"] = Value::String(c.clone());
                }
                o
            })
            .collect();

        let args = json!({
            "source": { "path": source },
            "breakpoints": bps,
            "lines": lines.iter().map(|(l, _)| l).collect::<Vec<_>>(),
            "sourceModified": false,
        });
        let resp = self.request("setBreakpoints", args)?;
        let arr = resp
            .get("body")
            .and_then(|b| b.get("breakpoints"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|bp| Breakpoint {
                verified: bp.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
                line: bp.get("line").and_then(|v| v.as_i64()).unwrap_or(0),
                message: bp
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
            .collect())
    }

    /// `configurationDone`: signal the adapter that the client finished setup.
    pub fn configuration_done(&mut self) -> Result<(), String> {
        self.request("configurationDone", json!({}))?;
        Ok(())
    }

    /// `threads`: list threads.
    pub fn threads(&mut self) -> Result<Vec<Thread>, String> {
        let resp = self.request("threads", json!({}))?;
        let arr = resp
            .get("body")
            .and_then(|b| b.get("threads"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|t| Thread {
                id: t.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                name: t
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unnamed)")
                    .to_string(),
            })
            .collect())
    }

    /// `stackTrace` for a thread.
    pub fn stack_trace(&mut self, thread_id: i64) -> Result<Vec<StackFrame>, String> {
        let args = json!({
            "threadId": thread_id,
            "startFrame": 0,
            "levels": 50,
            "format": { "includeLine": true, "module": true }
        });
        let resp = self.request("stackTrace", args)?;
        let arr = resp
            .get("body")
            .and_then(|b| b.get("stackFrames"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|f| StackFrame {
                id: f.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                name: f
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                source: f
                    .get("source")
                    .and_then(|s| s.get("path"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                line: f.get("line").and_then(|v| v.as_i64()).unwrap_or(0),
                column: f.get("column").and_then(|v| v.as_i64()).unwrap_or(0),
            })
            .collect())
    }

    /// `scopes` for a frame; cached so subsequent `variables("locals")` works.
    pub fn scopes(&mut self, frame_id: i64) -> Result<Vec<Scope>, String> {
        let resp = self.request("scopes", json!({ "frameId": frame_id }))?;
        let arr = resp
            .get("body")
            .and_then(|b| b.get("scopes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let scopes: Vec<Scope> = arr
            .into_iter()
            .map(|s| Scope {
                name: s
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                variables_reference: s
                    .get("variablesReference")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                expensive: s
                    .get("expensive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
            .collect();
        self.scopes.insert(frame_id, scopes.clone());
        Ok(scopes)
    }

    /// `variables` for a variablesReference, or for a named scope of the most
    /// recently fetched frame.
    pub fn variables(&mut self, variables_reference: i64) -> Result<Vec<Variable>, String> {
        let resp = self.request("variables", json!({ "variablesReference": variables_reference }))?;
        let arr = resp
            .get("body")
            .and_then(|b| b.get("variables"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|v| Variable {
                name: v
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                value: v
                    .get("value")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                r#type: v
                    .get("type")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                variables_reference: v
                    .get("variablesReference")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
            })
            .collect())
    }

    /// `evaluate` an expression in a frame (or `repl` context if no frame).
    pub fn evaluate(&mut self, expression: &str, frame_id: Option<i64>) -> Result<Variable, String> {
        let mut args = json!({ "expression": expression, "context": "repl" });
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        let resp = self.request("evaluate", args)?;
        let body = resp.get("body").ok_or("evaluate: missing body")?;
        Ok(Variable {
            name: expression.to_string(),
            value: body
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            r#type: body
                .get("type")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            variables_reference: body
                .get("variablesReference")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
        })
    }

    /// `continue`.
    pub fn continue_(&mut self, thread_id: i64) -> Result<(), String> {
        self.request("continue", json!({ "threadId": thread_id }))?;
        self.state = DebugState::Running;
        Ok(())
    }

    /// `pause`.
    pub fn pause(&mut self, thread_id: i64) -> Result<(), String> {
        self.request("pause", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// `next` (step over).
    pub fn next(&mut self, thread_id: i64) -> Result<(), String> {
        self.request("next", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// `stepIn`.
    pub fn step_in(&mut self, thread_id: i64) -> Result<(), String> {
        self.request("stepIn", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// `stepOut`.
    pub fn step_out(&mut self, thread_id: i64) -> Result<(), String> {
        self.request("stepOut", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// `disconnect`: close the session, optionally terminating the debuggee.
    pub fn disconnect(&mut self, terminate: bool) -> Result<(), String> {
        let args = json!({ "terminateDebuggee": terminate, "suspendDebuggee": false });
        // Best-effort: adapters may already be gone.
        let _ = self.request("disconnect", args);
        self.state = DebugState::Terminated;
        Ok(())
    }
}

impl Drop for DebugClient {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ---- Reader-thread plumbing -------------------------------------------------
//
// The client splits the adapter's stdio: the writer lives in the transport
// (used for `send_message`), the reader is moved into a dedicated background
// thread. The transport still needs *some* reader type, so we feed it a
// [`NullReader`] that always reads zero bytes — the client never calls
// `read_message` on it.

/// A reader that is always at EOF and never blocks. Used as a placeholder for
/// the transport's reader slot, since the real reader lives in the background
/// thread.
pub struct NullReader;

impl std::io::Read for NullReader {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

impl std::io::BufRead for NullReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        Ok(&[])
    }
    fn consume(&mut self, _amt: usize) {}
}

/// Read a single framed DAP message from `reader`. This is the function the
/// background reader thread calls in a loop.
pub fn read_message_from<R: std::io::BufRead>(reader: &mut R) -> Result<Value, DapError> {
    crate::protocol::read_one(reader)
}

/// Build adapter-specific `launch` arguments.
fn build_launch_arguments(kind: AdapterKind, program: &str, args: &[String]) -> Value {
    match kind {
        AdapterKind::Python => {
            let mut o = json!({
                "type": "python",
                "name": "Launch",
                "request": "launch",
                "program": program,
                "console": "internalConsole",
                "justMyCode": true,
            });
            if !args.is_empty() {
                o["args"] = json!(args);
            }
            o
        }
        AdapterKind::Lldb => {
            json!({
                "type": "lldb",
                "name": "Launch",
                "request": "launch",
                "program": program,
                "args": args,
                "cwd": ".",
                "stopOnEntry": false,
            })
        }
        AdapterKind::Go => {
            let mut o = json!({
                "type": "go",
                "name": "Launch",
                "request": "launch",
                "mode": "auto",
                "program": program,
            });
            if !args.is_empty() {
                o["args"] = json!(args);
            }
            o
        }
        AdapterKind::Node => {
            let mut o = json!({
                "type": "node",
                "name": "Launch",
                "request": "launch",
                "program": program,
            });
            if !args.is_empty() {
                o["args"] = json!(args);
            }
            o
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_launch_python() {
        let v = build_launch_arguments(AdapterKind::Python, "main.py", &[]);
        assert_eq!(v["type"], "python");
        assert_eq!(v["program"], "main.py");
    }

    #[test]
    fn build_launch_python_with_args() {
        let v = build_launch_arguments(
            AdapterKind::Python,
            "main.py",
            &["--foo".to_string(), "1".to_string()],
        );
        assert_eq!(v["args"], json!(["--foo", "1"]));
    }

    #[test]
    fn build_launch_lldb() {
        let v = build_launch_arguments(
            AdapterKind::Lldb,
            "./target/debug/app",
            &["x".to_string()],
        );
        assert_eq!(v["type"], "lldb");
        assert_eq!(v["args"], json!(["x"]));
    }

    #[test]
    fn debug_state_strings() {
        assert_eq!(DebugState::Idle.as_str(), "idle");
        assert_eq!(DebugState::Stopped.as_str(), "stopped");
    }
}
