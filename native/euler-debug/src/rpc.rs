//! Line-delimited JSON RPC surface.
//!
//! The `euler-debug` binary reads one JSON request per line from stdin and
//! writes one JSON response per line to stdout. This module defines the
//! request/response shapes and dispatches them against an owned [`DebugClient`].
//!
//! Keeping the surface tiny and uniform is the point: a weak model emits a
//! single JSON object per command and gets a single JSON object back. There is
//! no connection setup, no streaming, no partial state to track.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::client::{DebugClient, DebugState};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RpcRequest {
    /// Start the adapter and initialize the session.
    #[serde(rename = "start", alias = "initialize")]
    Start {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        adapter: Option<String>,
    },
    /// Launch the target program.
    #[serde(rename = "launch")]
    Launch {
        program: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Attach to a running PID.
    #[serde(rename = "attach")]
    Attach { pid: u32 },
    /// Set breakpoints in one source file.
    #[serde(rename = "setBreakpoints", alias = "set_breakpoints")]
    SetBreakpoints {
        source: String,
        /// Tuples of (line, optional condition).
        breakpoints: Vec<LineBreakpoint>,
    },
    /// Tell the adapter configuration is complete (usually resumes the program).
    #[serde(rename = "configurationDone", alias = "configuration_done")]
    ConfigurationDone,
    /// List threads.
    #[serde(rename = "threads")]
    Threads,
    /// Get the stack trace for a thread.
    #[serde(rename = "stackTrace", alias = "stack_trace")]
    StackTrace {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Get scopes for a frame.
    #[serde(rename = "scopes")]
    Scopes {
        #[serde(alias = "frameId")]
        frame_id: i64,
    },
    /// Get variables for a variablesReference.
    #[serde(rename = "variables")]
    Variables {
        #[serde(alias = "variablesReference")]
        variables_reference: i64,
    },
    /// Evaluate an expression in a frame (optional).
    #[serde(rename = "evaluate")]
    Evaluate {
        expression: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(alias = "frameId")]
        frame_id: Option<i64>,
    },
    /// Continue a thread.
    #[serde(rename = "continue", alias = "continue_")]
    Continue {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Pause a thread.
    #[serde(rename = "pause")]
    Pause {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Step over.
    #[serde(rename = "stepOver", alias = "next")]
    StepOver {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Step in.
    #[serde(rename = "stepIn")]
    StepIn {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Step out.
    #[serde(rename = "stepOut")]
    StepOut {
        #[serde(alias = "threadId")]
        thread_id: i64,
    },
    /// Block until the debuggee stops or terminates. Does not send a DAP
    /// request; just drains adapter events. `timeoutMs` caps the wait
    /// (default 30s, hard ceiling 60s).
    #[serde(rename = "waitForStop")]
    WaitForStop {
        #[serde(default, alias = "timeoutMs", alias = "timeout_ms")]
        timeout_ms: Option<u64>,
    },
    /// Disconnect / end the session.
    #[serde(rename = "disconnect")]
    Disconnect { #[serde(default = "default_true")] terminate: bool },
    /// Report adapter + state without touching the adapter.
    #[serde(rename = "status")]
    Status,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LineBreakpoint {
    pub line: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
}

fn default_true() -> bool {
    true
}

/// A successful RPC response carries `result`; a failure carries `error`.
#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RpcResponse {
    pub fn ok(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(message.into()),
        }
    }
}

pub type RpcResult = Result<Value, RpcError>;

#[derive(Error, Debug)]
#[error("{0}")]
pub struct RpcError(pub String);

impl From<String> for RpcError {
    fn from(s: String) -> Self {
        RpcError(s)
    }
}

/// A connection owns at most one live debug client. `start` creates it; all
/// other commands require it to exist.
pub struct RpcSession {
    client: Option<DebugClient>,
}

impl Default for RpcSession {
    fn default() -> Self {
        Self::new()
    }
}

impl RpcSession {
    pub fn new() -> Self {
        Self { client: None }
    }

    /// Dispatch a parsed request. Returns the `result` JSON to embed in the
    /// response on success, or an `RpcError` on failure.
    pub fn handle(&mut self, req: RpcRequest) -> RpcResult {
        match req {
            RpcRequest::Start { target, adapter } => {
                if self.client.is_some() {
                    return Err(RpcError(
                        "a session is already active; call 'disconnect' first".into(),
                    ));
                }
                let client = DebugClient::connect(&target, adapter.as_deref())?;
                let kind = client.adapter_kind();
                self.client = Some(client);
                Ok(serde_json::json!({
                    "started": true,
                    "adapter": kind.as_str(),
                    "state": DebugState::Initialized.as_str(),
                }))
            }

            RpcRequest::Status => {
                let state = match &self.client {
                    Some(c) => c.state(),
                    None => DebugState::Idle,
                };
                Ok(serde_json::json!({
                    "active": self.client.is_some(),
                    "state": state.as_str(),
                }))
            }

            // Everything below requires an active session.
            req @ (RpcRequest::Launch { .. }
            | RpcRequest::Attach { .. }
            | RpcRequest::SetBreakpoints { .. }
            | RpcRequest::ConfigurationDone
            | RpcRequest::Threads
            | RpcRequest::StackTrace { .. }
            | RpcRequest::Scopes { .. }
            | RpcRequest::Variables { .. }
            | RpcRequest::Evaluate { .. }
            | RpcRequest::Continue { .. }
            | RpcRequest::Pause { .. }
            | RpcRequest::StepOver { .. }
            | RpcRequest::StepIn { .. }
            | RpcRequest::StepOut { .. }
            | RpcRequest::WaitForStop { .. }
            | RpcRequest::Disconnect { .. }) => {
                self.require_active(&req)
            }
        }
    }

    fn client(&mut self) -> Result<&mut DebugClient, RpcError> {
        self.client
            .as_mut()
            .ok_or_else(|| RpcError("no active session; call 'start' first".into()))
    }

    fn require_active(&mut self, req: &RpcRequest) -> RpcResult {
        match req {
            RpcRequest::Launch { program, args } => {
                let c = self.client()?;
                c.launch_program(program, args)?;
                Ok(serde_json::json!({ "launched": true, "program": program }))
            }
            RpcRequest::Attach { pid } => {
                let c = self.client()?;
                c.attach(*pid)?;
                Ok(serde_json::json!({ "attached": true, "pid": pid }))
            }
            RpcRequest::SetBreakpoints { source, breakpoints } => {
                let lines: Vec<(i64, Option<String>)> = breakpoints
                    .iter()
                    .map(|b| (b.line, b.condition.clone()))
                    .collect();
                let c = self.client()?;
                let bps = c.set_breakpoints(source, &lines)?;
                Ok(serde_json::json!({ "breakpoints": bps }))
            }
            RpcRequest::ConfigurationDone => {
                let c = self.client()?;
                c.configuration_done()?;
                Ok(serde_json::json!({ "configurationDone": true }))
            }
            RpcRequest::Threads => {
                let c = self.client()?;
                let threads = c.threads()?;
                Ok(serde_json::json!({ "threads": threads }))
            }
            RpcRequest::StackTrace { thread_id } => {
                let c = self.client()?;
                let frames = c.stack_trace(*thread_id)?;
                Ok(serde_json::json!({ "stackFrames": frames, "threadId": thread_id }))
            }
            RpcRequest::Scopes { frame_id } => {
                let c = self.client()?;
                let scopes = c.scopes(*frame_id)?;
                Ok(serde_json::json!({ "scopes": scopes, "frameId": frame_id }))
            }
            RpcRequest::Variables { variables_reference } => {
                let c = self.client()?;
                let vars = c.variables(*variables_reference)?;
                Ok(serde_json::json!({ "variables": vars }))
            }
            RpcRequest::Evaluate {
                expression,
                frame_id,
            } => {
                let c = self.client()?;
                let res = c.evaluate(expression, *frame_id)?;
                Ok(serde_json::json!({ "result": res }))
            }
            RpcRequest::Continue { thread_id } => {
                let c = self.client()?;
                c.continue_(*thread_id)?;
                Ok(serde_json::json!({ "running": true, "threadId": thread_id }))
            }
            RpcRequest::Pause { thread_id } => {
                let c = self.client()?;
                c.pause(*thread_id)?;
                Ok(serde_json::json!({ "paused": true, "threadId": thread_id }))
            }
            RpcRequest::StepOver { thread_id } => {
                let c = self.client()?;
                c.next(*thread_id)?;
                Ok(serde_json::json!({ "step": "over", "threadId": thread_id }))
            }
            RpcRequest::StepIn { thread_id } => {
                let c = self.client()?;
                c.step_in(*thread_id)?;
                Ok(serde_json::json!({ "step": "in", "threadId": thread_id }))
            }
            RpcRequest::StepOut { thread_id } => {
                let c = self.client()?;
                c.step_out(*thread_id)?;
                Ok(serde_json::json!({ "step": "out", "threadId": thread_id }))
            }
            RpcRequest::WaitForStop { timeout_ms } => {
                let c = self.client()?;
                // Default 30s; hard ceiling 60s so a forgotten agent call can't
                // pin a session forever.
                let ms = timeout_ms.unwrap_or(30_000).min(60_000);
                let result = c.wait_for_stop(std::time::Duration::from_millis(ms))?;
                Ok(serde_json::json!({ "wait": result }))
            }
            RpcRequest::Disconnect { terminate } => {
                if let Some(c) = self.client.as_mut() {
                    c.disconnect(*terminate)?;
                }
                self.client = None;
                Ok(serde_json::json!({ "terminated": true }))
            }
            // Start/Status handled in `handle`.
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_with_no_session() {
        let mut s = RpcSession::new();
        let v = s.handle(RpcRequest::Status).unwrap();
        assert_eq!(v["active"], false);
        assert_eq!(v["state"], "idle");
    }

    #[test]
    fn launch_without_session_errors() {
        let mut s = RpcSession::new();
        let req = RpcRequest::Launch {
            program: "main.py".into(),
            args: vec![],
        };
        let err = s.handle(req).unwrap_err();
        assert!(err.0.contains("no active session"));
    }

    #[test]
    fn disconnect_is_idempotent() {
        let mut s = RpcSession::new();
        let req = RpcRequest::Disconnect { terminate: true };
        let v = s.handle(req).unwrap();
        assert_eq!(v["terminated"], true);
    }

    #[test]
    fn parses_start_request() {
        let line = r#"{"op":"start","target":"main.py"}"#;
        let req: RpcRequest = serde_json::from_str(line).unwrap();
        match req {
            RpcRequest::Start { target, adapter } => {
                assert_eq!(target, "main.py");
                assert!(adapter.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_set_breakpoints_request() {
        let line = r#"{"op":"setBreakpoints","source":"src/main.rs","breakpoints":[{"line":42},{"line":50,"condition":"x > 10"}]}"#;
        let req: RpcRequest = serde_json::from_str(line).unwrap();
        match req {
            RpcRequest::SetBreakpoints { source, breakpoints } => {
                assert_eq!(source, "src/main.rs");
                assert_eq!(breakpoints.len(), 2);
                assert_eq!(breakpoints[1].condition.as_deref(), Some("x > 10"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_wait_for_stop_request() {
        // With an explicit timeout.
        let line = r#"{"op":"waitForStop","timeoutMs":5000}"#;
        let req: RpcRequest = serde_json::from_str(line).unwrap();
        match req {
            RpcRequest::WaitForStop { timeout_ms } => {
                assert_eq!(timeout_ms, Some(5000));
            }
            _ => panic!("wrong variant"),
        }
        // Without a timeout (default applies in the handler).
        let line = r#"{"op":"waitForStop"}"#;
        let req: RpcRequest = serde_json::from_str(line).unwrap();
        match req {
            RpcRequest::WaitForStop { timeout_ms } => assert_eq!(timeout_ms, None),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn wait_for_stop_requires_active_session() {
        let mut s = RpcSession::new();
        let req = RpcRequest::WaitForStop { timeout_ms: None };
        let err = s.handle(req).unwrap_err();
        assert!(err.0.contains("no active session"));
    }

    #[test]
    fn response_ok_shape() {
        let r = RpcResponse::ok(serde_json::json!({"x": 1}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"x\":1"));
        assert!(!s.contains("error"));
    }

    #[test]
    fn response_err_shape() {
        let r = RpcResponse::err("boom");
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"ok\":false"));
        assert!(s.contains("boom"));
        assert!(!s.contains("result"));
    }
}
