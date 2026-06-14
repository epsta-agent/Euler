//! End-to-end test: spawn the `euler-debug` binary and drive a *real* debug
//! session against debugpy (if Python + debugpy are installed) and against
//! lldb-dap (if installed). These are integration tests and are skipped when
//! the relevant adapter is not present, so they pass in any environment.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Once;

static BUILD_ONCE: Once = Once::new();

fn binary_path() -> PathBuf {
    // `cargo test` runs with CARGO_BIN_EXE_<name> env available to the test
    // harness; fall back to the debug build artifact if not.
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_euler-debug") {
        return PathBuf::from(p);
    }
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // native/euler-debug -> native/target/debug/euler-debug
    p.push("../target/debug/euler-debug");
    if !p.exists() {
        panic!(
            "euler-debug binary not found at {}; run `cargo build -p euler-debug --bin euler-debug` first",
            p.display()
        );
    }
    p
}

struct Driver {
    child: Child,
}

impl Driver {
    fn spawn() -> Self {
        BUILD_ONCE.call_once(|| {
            // Best-effort: ensure the binary is built before the test runs.
            let _ = Command::new("cargo")
                .args([
                    "build",
                    "--manifest-path",
                    concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.toml"),
                    "-p",
                    "euler-debug",
                    "--bin",
                    "euler-debug",
                ])
                .status();
        });

        let child = Command::new(binary_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn euler-debug");
        Self { child }
    }

    fn send(&mut self, line: &str) -> serde_json::Value {
        {
            let stdin = self.child.stdin.as_mut().expect("stdin open");
            writeln!(stdin, "{line}").expect("write");
            stdin.flush().expect("flush");
        }
        let stdout = self.child.stdout.as_mut().expect("stdout open");
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        reader.read_line(&mut buf).expect("read response");
        serde_json::from_str(buf.trim()).unwrap_or_else(|e| {
            panic!("failed to parse response `{buf}`: {e}");
        })
    }

    fn close(mut self) {
        // Dropping stdin should make the binary exit.
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

fn python_with_debugpy() -> Option<String> {
    let py = std::env::var("PYTHON").ok().unwrap_or_else(|| "python3".into());
    let ok = Command::new(&py)
        .arg("-c")
        .arg("import debugpy")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Some(py)
    } else {
        None
    }
}

#[test]
fn status_round_trip() {
    let mut d = Driver::spawn();
    let resp = d.send(r#"{"op":"status"}"#);
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["result"]["active"], false);
    d.close();
}

#[test]
fn unknown_op_lists_valid_ops() {
    let mut d = Driver::spawn();
    let resp = d.send(r#"{"op":"notARealOp"}"#);
    assert_eq!(resp["ok"], false);
    let err = resp["error"].as_str().unwrap();
    assert!(err.contains("unknown variant") || err.contains("invalid"));
    d.close();
}

#[test]
fn detect_python_adapter() {
    let mut d = Driver::spawn();
    let sample = fixture("sample.py");
    let req = format!(r#"{{"op":"start","target":{}}}"#, serde_json::json!(sample.to_string_lossy()));
    let resp = d.send(&req);
    if python_with_debugpy().is_some() {
        assert_eq!(resp["ok"], true, "expected ok, got: {resp}");
        assert_eq!(resp["result"]["adapter"], "python");
        assert_eq!(resp["result"]["state"], "initialized");
    } else {
        // Without debugpy we expect an actionable error mentioning the install.
        assert_eq!(resp["ok"], false, "got: {resp}");
    }
    let _ = d.send(r#"{"op":"disconnect","terminate":true}"#);
    d.close();
}

#[test]
fn full_python_session() {
    let python = match python_with_debugpy() {
        Some(p) => p,
        None => {
            eprintln!("skipping full_python_session: debugpy not installed");
            return;
        }
    }
    .clone();
    let mut d = Driver::spawn();
    let sample = fixture("sample.py");

    // debugpy expects: initialize -> launch -> setBreakpoints -> configurationDone.
    // Start the adapter (sends initialize).
    let req = format!(
        r#"{{"op":"start","target":{},"adapter":"python"}}"#,
        serde_json::json!(sample.to_string_lossy())
    );
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "start failed: {resp}");

    // Launch the program.
    let req = format!(
        r#"{{"op":"launch","program":{}}}"#,
        serde_json::json!(sample.to_string_lossy())
    );
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "launch failed: {resp}");

    // Set a breakpoint on the `total = add(x, y)` line (line 11 in sample.py).
    let req = format!(
        r#"{{"op":"setBreakpoints","source":{},"breakpoints":[{{"line":11}}]}}"#,
        serde_json::json!(sample.to_string_lossy())
    );
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "setBreakpoints failed: {resp}");
    assert!(resp["result"]["breakpoints"][0]["verified"].as_bool().unwrap_or(false),
        "breakpoint not verified: {resp}");

    // Configuration done — this resumes the program.
    let resp = d.send(r#"{"op":"configurationDone"}"#);
    assert_eq!(resp["ok"], true, "configurationDone failed: {resp}");

    // Block until the breakpoint is hit. This replaces a fragile fixed sleep:
    // waitForStop drains adapter `stopped` events and returns the moment the
    // debuggee pauses (or times out / terminates).
    let resp = d.send(r#"{"op":"waitForStop","timeoutMs":15000}"#);
    assert_eq!(resp["ok"], true, "waitForStop failed: {resp}");
    let event = resp["result"]["wait"]["event"].as_str().unwrap_or("");
    assert_eq!(
        event, "stopped",
        "expected the breakpoint to stop the program, got: {resp}"
    );
    let tid = resp["result"]["wait"]["threadId"]
        .as_i64()
        .expect("a thread id on the stopped event");

    // Stack trace.
    let req = format!(r#"{{"op":"stackTrace","threadId":{tid}}}"#);
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "stackTrace failed: {resp}");
    let frames = resp["result"]["stackFrames"].as_array().expect("frames array");
    assert!(!frames.is_empty(), "expected at least one stack frame");
    let frame_id = frames[0]["id"].as_i64().unwrap();

    // Scopes for the top frame.
    let req = format!(r#"{{"op":"scopes","frameId":{frame_id}}}"#);
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "scopes failed: {resp}");
    let scopes = resp["result"]["scopes"].as_array().expect("scopes array");
    assert!(!scopes.is_empty(), "expected at least one scope");
    let locals_ref = scopes
        .iter()
        .find(|s| s["name"].as_str().unwrap_or("").to_lowercase().contains("local"))
        .map(|s| s["variablesReference"].as_i64().unwrap())
        .unwrap_or(scopes[0]["variablesReference"].as_i64().unwrap());

    // Variables in the locals scope.
    let req = format!(r#"{{"op":"variables","variablesReference":{locals_ref}}}"#);
    let resp = d.send(&req);
    assert_eq!(resp["ok"], true, "variables failed: {resp}");
    let vars = resp["result"]["variables"].as_array().expect("vars array");
    // We expect at least the locals x and y to be present.
    let names: Vec<String> = vars
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(names.iter().any(|n| n == "x"), "expected local `x`, got {names:?}");
    assert!(names.iter().any(|n| n == "y"), "expected local `y`, got {names:?}");

    // Evaluate an expression.
    let resp = d.send(
        format!(r#"{{"op":"evaluate","expression":"x + y","frameId":{frame_id}}}"#).as_str(),
    );
    assert_eq!(resp["ok"], true, "evaluate failed: {resp}");

    // Disconnect cleanly.
    let resp = d.send(r#"{"op":"disconnect","terminate":true}"#);
    assert_eq!(resp["ok"], true, "disconnect failed: {resp}");

    // Silence unused `python` warning; it's only used to gate the test.
    let _ = Path::new(&python);

    d.close();
}
