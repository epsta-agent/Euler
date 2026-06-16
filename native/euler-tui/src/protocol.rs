//! Wire protocol for the agent subprocess bridge.
//!
//! This is the Rust mirror of `src/agent/bridge/protocol.ts`. The two must
//! stay byte-compatible: every variant and field here corresponds to a JSON
//! shape the TypeScript host emits or consumes. Drift = silent breakage.
//!
//! Format: line-delimited JSON on stdio.
//!   - TUI → agent : `Request` (one per stdin line)
//!   - agent → TUI : `Response` or `Event` (one per stdout line)
//!   - all agent logging goes to its stderr (never stdout)

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request from the TUI to the agent. Tagged on `op` (serde internally tagged),
/// matching the TS `{ op, ... }` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum Request {
    #[serde(rename = "initialize")]
    Initialize { config: InitializeConfig },
    #[serde(rename = "process")]
    Process { message: String },
    #[serde(rename = "interrupt")]
    Interrupt,
    /// Reset the agent's in-memory conversation (used by /clear). The process
    /// stays alive — only the conversation history + active turn are dropped.
    #[serde(rename = "reset")]
    Reset,
    #[serde(rename = "shutdown")]
    Shutdown,
}

/// Configuration for an `initialize` request.
///
/// Serialized with camelCase field names so it matches the TS
/// `InitializeConfig` in src/agent/bridge/protocol.ts (apiKey, baseUrl, …).
/// Without `rename_all`, serde emits snake_case keys that the TS host silently
/// ignores — which means explicit credentials never reach the coordinator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeConfig {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_rounds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// If true, the agent resumes its most recent persisted session on init.
    #[serde(default, skip_serializing_if = "is_false")]
    pub resume: bool,
}

/// Predicate for `skip_serializing_if`. serde's attribute requires a `&T ->
/// bool` signature, so this intentionally takes a reference (clippy's
/// "pass by value" suggestion does not apply to serde predicates).
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !b
}

/// Uniform response envelope from the agent. `ok: false` carries an error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An unsolicited event emitted DURING a `process` op. Tagged on `event`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum Event {
    /// Assistant text (the full turn text in the tool-loop path).
    #[serde(rename = "message")]
    Message { data: MessageData },
    /// A tool is about to run.
    #[serde(rename = "tool_start")]
    ToolStart { data: ToolEventData },
    /// A tool finished.
    #[serde(rename = "tool_end")]
    ToolEnd { data: ToolEndData },
    /// The process op completed with a final response.
    #[serde(rename = "done")]
    Done { data: DoneData },
    /// An error occurred.
    #[serde(rename = "error")]
    Error { data: ErrorData },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageData {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolEventData {
    pub tool: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolEndData {
    pub tool: String,
    pub input: Value,
    pub result: ToolResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoneData {
    pub response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorData {
    pub error: String,
}

/// Anything the agent writes to stdout is either a Response or an Event.
/// We deserialize by peeking at the discriminator field.
#[derive(Debug, Clone)]
pub enum AgentMessage {
    Response(Response),
    Event(Event),
}

impl AgentMessage {
    /// Parse one stdout line. Returns None for empty/whitespace lines.
    pub fn parse(line: &str) -> Option<Self> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        // Events have an "event" string field; responses have an "ok" boolean.
        // Peek at the parsed object to disambiguate, then deserialize into the
        // right type. This mirrors the TS `isBridgeEvent` discriminator.
        let v: Value = serde_json::from_str(trimmed).ok()?;
        if v.get("event").and_then(|e| e.as_str()).is_some() {
            let event: Event = serde_json::from_value(v).ok()?;
            Some(AgentMessage::Event(event))
        } else {
            let resp: Response = serde_json::from_value(v).ok()?;
            Some(AgentMessage::Response(resp))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_initialize_request() {
        let line = r#"{"op":"initialize","config":{"provider":"deepseek","model":"deepseek-chat"}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        match req {
            Request::Initialize { config } => {
                assert_eq!(config.provider, "deepseek");
                assert_eq!(config.model, "deepseek-chat");
            }
            _ => panic!("expected Initialize"),
        }
    }

    #[test]
    fn parse_process_request() {
        let line = r#"{"op":"process","message":"hello"}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        match req {
            Request::Process { message } => assert_eq!(message, "hello"),
            _ => panic!("expected Process"),
        }
    }

    #[test]
    fn parse_interrupt_and_shutdown() {
        let r1: Request = serde_json::from_str(r#"{"op":"interrupt"}"#).unwrap();
        assert!(matches!(r1, Request::Interrupt));
        let r2: Request = serde_json::from_str(r#"{"op":"shutdown"}"#).unwrap();
        assert!(matches!(r2, Request::Shutdown));
    }

    #[test]
    fn parse_reset_request() {
        let r: Request = serde_json::from_str(r#"{"op":"reset"}"#).unwrap();
        assert!(matches!(r, Request::Reset));
        // Round-trip through serialization.
        let json = serde_json::to_string(&Request::Reset).unwrap();
        assert_eq!(json, r#"{"op":"reset"}"#);
    }

    #[test]
    fn initialize_config_resume_round_trip() {
        // resume defaults to omitted (skip_serializing_if = is_false).
        let cfg = InitializeConfig {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            api_key: None,
            base_url: None,
            max_tool_rounds: None,
            temperature: None,
            system_prompt: None,
            resume: false,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(!s.contains("resume"), "resume should be omitted when false: {s}");

        // When true it's included.
        let cfg2 = InitializeConfig { resume: true, ..cfg };
        let s2 = serde_json::to_string(&cfg2).unwrap();
        assert!(s2.contains("\"resume\":true"), "resume should be present when true: {s2}");

        // Deserializing a line without resume defaults to false.
        let parsed: InitializeConfig = serde_json::from_str(
            r#"{"provider":"openai","model":"gpt-4o-mini"}"#,
        )
        .unwrap();
        assert!(!parsed.resume);
    }

    #[test]
    fn initialize_config_serializes_camel_case_keys() {
        // The TS host reads cfg.apiKey / cfg.baseUrl (camelCase). If the Rust
        // side emits snake_case (api_key), the credentials are silently dropped
        // — this test pins the rename.
        let cfg = InitializeConfig {
            provider: "zai".into(),
            model: "m".into(),
            api_key: Some("sk-mock".into()),
            base_url: Some("http://localhost:5601/v1".into()),
            max_tool_rounds: Some(30),
            temperature: None,
            system_prompt: None,
            resume: false,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(s.contains("\"apiKey\":\"sk-mock\""), "expected camelCase apiKey: {s}");
        assert!(s.contains("\"baseUrl\":\"http://localhost:5601/v1\""), "expected camelCase baseUrl: {s}");
        assert!(s.contains("\"maxToolRounds\":30"), "expected camelCase maxToolRounds: {s}");
        assert!(!s.contains("api_key"), "snake_case leaked: {s}");
        assert!(!s.contains("base_url"), "snake_case leaked: {s}");
    }

    #[test]
    fn parse_message_event() {
        let line = r#"{"event":"message","data":{"text":"hi there"}}"#;
        let msg = AgentMessage::parse(line).unwrap();
        match msg {
            AgentMessage::Event(Event::Message { data }) => assert_eq!(data.text, "hi there"),
            _ => panic!("expected Message event"),
        }
    }

    #[test]
    fn parse_tool_events() {
        let start = r#"{"event":"tool_start","data":{"tool":"read","input":{"path":"/x"}}}"#;
        let msg = AgentMessage::parse(start).unwrap();
        match msg {
            AgentMessage::Event(Event::ToolStart { data }) => {
                assert_eq!(data.tool, "read");
            }
            _ => panic!("expected ToolStart"),
        }

        let end = r#"{"event":"tool_end","data":{"tool":"bash","input":{"command":"ls"},"result":{"content":"a\nb","isError":false}}}"#;
        let msg = AgentMessage::parse(end).unwrap();
        match msg {
            AgentMessage::Event(Event::ToolEnd { data }) => {
                assert_eq!(data.tool, "bash");
                assert!(!data.result.is_error);
            }
            _ => panic!("expected ToolEnd"),
        }
    }

    #[test]
    fn parse_done_and_error_events() {
        let done = r#"{"event":"done","data":{"response":"all done"}}"#;
        match AgentMessage::parse(done).unwrap() {
            AgentMessage::Event(Event::Done { data }) => assert_eq!(data.response, "all done"),
            _ => panic!("expected Done"),
        }
        let err = r#"{"event":"error","data":{"error":"boom"}}"#;
        match AgentMessage::parse(err).unwrap() {
            AgentMessage::Event(Event::Error { data }) => assert_eq!(data.error, "boom"),
            _ => panic!("expected Error"),
        }
    }

    #[test]
    fn parse_response_envelope() {
        let ok = r#"{"ok":true,"result":{"provider":"deepseek"}}"#;
        match AgentMessage::parse(ok).unwrap() {
            AgentMessage::Response(r) => {
                assert!(r.ok);
                assert!(r.result.is_some());
            }
            AgentMessage::Event(_) => panic!("expected Response"),
        }
        let fail = r#"{"ok":false,"error":"no key"}"#;
        match AgentMessage::parse(fail).unwrap() {
            AgentMessage::Response(r) => {
                assert!(!r.ok);
                assert_eq!(r.error.as_deref(), Some("no key"));
            }
            AgentMessage::Event(_) => panic!("expected Response"),
        }
    }

    #[test]
    fn empty_line_is_none() {
        assert!(AgentMessage::parse("").is_none());
        assert!(AgentMessage::parse("   ").is_none());
    }

    #[test]
    fn roundtrip_request_json() {
        // Serialize then parse back — ensures our serde config is symmetric.
        let req = Request::Process {
            message: "test".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: Request = serde_json::from_str(&json).unwrap();
        match back {
            Request::Process { message } => assert_eq!(message, "test"),
            _ => panic!("roundtrip failed"),
        }
    }
}
