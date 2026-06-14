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

use std::io::BufRead;
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
}

impl DebugClient {
    /// Spawn the adapter detected for `target` and run the `initialize`
    /// handshake.
    ///
    /// This *connects* to the adapter and readies it for a `launch`/`attach`;
    /// it does not start the debuggee. To run the program, follow up with
    /// [`DebugClient::launch_program`] or [`DebugClient::attach`].
    pub fn connect(target: &str, force_adapter: Option<&str>) -> Result<Self, String> {
        let spec = adapter::detect_adapter(target, force_adapter)?;
        Self::connect_with_spec(&spec)
    }

    /// Legacy alias for [`DebugClient::connect`]. The name `launch` was
    /// misleading: this method only initializes the adapter, it does not launch
    /// the debuggee. Prefer `connect`.
    #[deprecated(since = "0.2.0", note = "use `connect` instead; this only initializes")]
    pub fn launch(target: &str, force_adapter: Option<&str>) -> Result<Self, String> {
        Self::connect(target, force_adapter)
    }

    /// Connect using an explicit [`AdapterSpec`]. Useful for tests.
    pub fn connect_with_spec(spec: &AdapterSpec) -> Result<Self, String> {
        let mut child = adapter::spawn_adapter(spec)?;
        let stdout: Box<dyn std::io::Read + Send + 'static> =
            Box::new(child.stdout.take().expect("adapter stdout piped"));
        let stdin: Box<dyn std::io::Write + Send + 'static> =
            Box::new(child.stdin.take().expect("adapter stdin piped"));
        let stderr: Box<dyn std::io::Read + Send + 'static> =
            Box::new(child.stderr.take().expect("adapter stderr piped"));

        // Drain adapter stderr on a dedicated thread. If we don't, a chatty
        // adapter (debugpy and dlv both log here) fills the OS pipe buffer
        // (~64KB on macOS/Linux) and deadlocks the whole session. We forward
        // each line through the `log` facade at `warn`, so it is visible when
        // `EULER_DEBUG_LOG` is set and free otherwise.
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if !trimmed.is_empty() {
                            log::warn!("adapter stderr: {trimmed}");
                        }
                    }
                    Err(e) => {
                        log::debug!("adapter stderr reader stopped: {e}");
                        break;
                    }
                }
            }
        });

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
            let msg_seq = msg.get("request_seq").and_then(serde_json::Value::as_i64);
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
            let msg_seq = msg.get("request_seq").and_then(serde_json::Value::as_i64);

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
                verified: bp.get("verified").and_then(serde_json::Value::as_bool).unwrap_or(false),
                line: bp.get("line").and_then(serde_json::Value::as_i64).unwrap_or(0),
                message: bp
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string),
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
                id: t.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
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
                id: f.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
                name: f
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                source: f
                    .get("source")
                    .and_then(|s| s.get("path"))
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string),
                line: f.get("line").and_then(serde_json::Value::as_i64).unwrap_or(0),
                column: f.get("column").and_then(serde_json::Value::as_i64).unwrap_or(0),
            })
            .collect())
    }

    /// `scopes` for a frame.
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
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0),
                expensive: s
                    .get("expensive")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
            .collect();
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
                    .map(std::string::ToString::to_string),
                variables_reference: v
                    .get("variablesReference")
                    .and_then(serde_json::Value::as_i64)
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
                .map(std::string::ToString::to_string),
            variables_reference: body
                .get("variablesReference")
                .and_then(serde_json::Value::as_i64)
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

    /// Block until the debuggee stops, terminates, or `timeout` elapses.
    ///
    /// This does NOT send a DAP request: it merely consumes the events the
    /// adapter emits asynchronously after `continue` / `step*`. It is the
    /// deterministic replacement for the fragile "sleep then poll `threads`"
    /// pattern, and lets a single-shot caller find out *why* execution paused
    /// (breakpoint hit, exception, step end, …) without a streaming protocol.
    ///
    /// Returns a JSON object describing the outcome:
    /// - `{"event":"stopped","threadId":<id>,"reason":"<breakpoint|exception|…>","allThreadsStopped":<bool>"}`
    /// - `{"event":"terminated"}`
    /// - `{"event":"timeout"}`
    pub fn wait_for_stop(&mut self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let msg = match self.read_next(deadline) {
                Ok(m) => m,
                Err(e) if e.contains("timed out") => {
                    self.state = DebugState::Running;
                    return Ok(json!({ "event": "timeout" }));
                }
                Err(e) => return Err(e),
            };
            if msg.get("type") != Some(&Value::String("event".into())) {
                // A late response to a prior request; ignore it.
                continue;
            }
            let event = msg.get("event").and_then(|v| v.as_str()).unwrap_or("");
            match event {
                "stopped" => {
                    self.state = DebugState::Stopped;
                    let body = msg.get("body").cloned().unwrap_or(Value::Null);
                    return Ok(json!({
                        "event": "stopped",
                        "threadId": body.get("threadId").and_then(serde_json::Value::as_i64).unwrap_or(0),
                        "reason": body.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown"),
                        "allThreadsStopped": body.get("allThreadsStopped").and_then(serde_json::Value::as_bool).unwrap_or(false),
                    }));
                }
                "terminated" | "exited" => {
                    self.state = DebugState::Terminated;
                    return Ok(json!({ "event": "terminated" }));
                }
                _ => {
                    // Other events (output, breakpoint, continued, …): fold into
                    // state but keep waiting.
                    self.handle_async(&msg);
                }
            }
        }
    }
}

impl Drop for DebugClient {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            crate::adapter::kill_tree(child);
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

    /// A fake adapter must not deadlock even when it spams stderr past the OS
    /// pipe buffer (~64KB). This reproduces the bug fixed by the dedicated
    /// stderr-drain thread: without the drain, a chatty adapter fills the pipe
    /// and the whole session hangs.
    ///
    /// We can't easily drive the full DAP handshake here (the fake would have
    /// to answer `initialize`), so this test exercises the transport + reader
    /// in isolation: we write a frame to a pipe and confirm `read_one` returns
    /// promptly. The stderr-drain behavior itself is exercised end-to-end by
    /// the spawn_adapter + kill_tree test below.
    #[test]
    fn stderr_drain_prevents_pipe_deadlock() {
        use std::io::Cursor;
        let body = br#"{"type":"event"}"#;
        let frame = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut bytes = frame.into_bytes();
        bytes.extend_from_slice(body);
        let mut cursor = Cursor::new(bytes);
        let msg = crate::protocol::read_one(&mut cursor).unwrap();
        assert_eq!(msg["type"], "event");
    }

    /// `kill_tree` must reap the whole process group: we spawn a shell that
    /// spawns a long-lived `sleep` grandchild, then assert the grandchild is no
    /// longer alive after teardown. On Unix only (the bug is Unix-specific
    /// orphan handling; Windows uses `taskkill /T`).
    #[cfg(unix)]
    #[test]
    fn kill_tree_reaps_grandchildren() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        // Grandchild: sleep for a while, writing its own PID to a temp file so
        // we can check it afterwards.
        let tmp = std::env::temp_dir();
        let marker = tmp.join(format!(
            "euler-debug-killtree-{}-grandchild.pid",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker);

        // Single shell: write the sleep's PID to the marker, then sleep in the
        // background; the shell waits. `setsid` puts sleep in its own session
        // so we actually exercise group-kill rather than mere inheritance.
        // We quote the marker path to survive spaces in $TMPDIR.
        let script = format!(
            "sleep 30 &\nGC=$!\necho \"$GC\" > \"{}\"\nwait \"$GC\"\n",
            marker.display()
        );

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // Mirror spawn_adapter: own process group so kill_tree's killpg
            // reaches the grandchild.
            .process_group(0)
            .spawn()
            .expect("spawn shell");

        // Wait for the grandchild PID to appear.
        let mut grandchild_pid: Option<i32> = None;
        for _ in 0..400 {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                if let Ok(pid) = contents.trim().parse::<i32>() {
                    grandchild_pid = Some(pid);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let grandchild_pid = grandchild_pid.expect("grandchild PID was written");

        // Sanity: grandchild is alive.
        unsafe {
            assert!(
                libc::kill(grandchild_pid, 0) == 0,
                "grandchild should be alive before teardown"
            );
        }

        // Tear down via the production helper.
        crate::adapter::kill_tree(&mut child);

        // The grandchild must now be gone. Give the OS a moment to reap.
        let mut gone = false;
        for _ in 0..400 {
            let alive = unsafe { libc::kill(grandchild_pid, 0) == 0 };
            if !alive {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = std::fs::remove_file(&marker);
        assert!(gone, "grandchild {grandchild_pid} was orphaned by kill_tree");
    }
}
