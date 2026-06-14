//! DAP JSON-RPC transport.
//!
//! The Debug Adapter Protocol frames each message with ASCII headers followed
//! by a blank line and a UTF-8 JSON body:
//!
//! ```text
//! Content-Length: 123\r\n
//! \r\n
//! { ...json... }
//! ```
//!
//! [`DapTransport`] reads from a `BufRead` (adapter stdout) and writes to a
//! `Write` (adapter stdin). It is synchronous and blocking, matching how DAP
//! adapters operate on stdio.

use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;

/// Errors that can occur while speaking DAP.
#[derive(Error, Debug)]
pub enum DapError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("malformed DAP header: {0}")]
    BadHeader(String),
    #[error("malformed DAP JSON body: {0}")]
    BadJson(#[from] serde_json::Error),
    #[error("adapter closed the stream (EOF)")]
    Eof,
    #[error("timed out waiting for adapter response after {0:?}")]
    Timeout(Duration),
    #[error("adapter reported error: {0}")]
    Adapter(String),
}

/// A duplex DAP transport over a reader + writer pair.
///
/// The writer is guarded by a `Mutex` so requests can be sent from one thread
/// while the reader thread drains events. Reads are *not* mutex-guarded: only
/// one thread should ever call [`DapTransport::read_message`].
pub struct DapTransport<R: BufRead + Send + 'static, W: Write + Send + 'static> {
    reader: Mutex<R>,
    writer: Mutex<BufWriter<W>>,
}

impl<R: BufRead + Send + 'static, W: Write + Send + 'static> DapTransport<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader: Mutex::new(reader),
            writer: Mutex::new(BufWriter::new(writer)),
        }
    }

    /// Serialize and send a DAP message, flushing the writer.
    pub fn send_message(&self, msg: &Value) -> Result<(), DapError> {
        let body = serde_json::to_vec(msg)?;
        // Write under the writer lock and flush immediately so the adapter
        // receives the full frame without waiting for buffer pressure.
        let w = &mut *self.writer.lock().unwrap();
        write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
        w.write_all(&body)?;
        w.flush()?;
        Ok(())
    }

    /// Read a single DAP message (header + body). Blocks until a whole frame
    /// is available or the stream ends.
    pub fn read_message(&self) -> Result<Value, DapError> {
        let r = &mut *self.reader.lock().unwrap();
        read_one(r)
    }
}

/// Convenience constructor that wraps a raw `Child`'s stdout/stdin into a
/// transport. Returns `(transport, child_handle)` so the caller can wait on
/// the child.
pub fn transport_from_child(
    stdout: Box<dyn Read + Send + 'static>,
    stdin: Box<dyn Write + Send + 'static>,
) -> DapTransport<BufReader<Box<dyn Read + Send + 'static>>, Box<dyn Write + Send + 'static>> {
    DapTransport::new(BufReader::new(stdout), stdin)
}

/// Read a single framed DAP message from `r`.
///
/// Exposed (not a method) so it can be unit-tested with an in-memory cursor.
pub fn read_one<R: BufRead>(r: &mut R) -> Result<Value, DapError> {
    // Parse headers until a blank line.
    let mut content_length: Option<usize> = None;
    loop {
        let mut header = String::new();
        let n = r.read_line(&mut header)?;
        if n == 0 {
            // EOF before any header on a fresh read.
            return Err(DapError::Eof);
        }
        let trimmed = header.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.is_empty() {
            // Blank line: end of headers.
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                rest.trim()
                    .parse::<usize>()
                    .map_err(|e| DapError::BadHeader(format!("bad Content-Length: {e}")))?,
            );
        } else {
            // Ignore unknown headers (e.g. Seq:, Source:). DAP only mandates
            // Content-Length.
        }
    }

    let len =
        content_length.ok_or_else(|| DapError::BadHeader("missing Content-Length header".into()))?;

    // Read exactly `len` bytes of body.
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let value: Value = serde_json::from_slice(&buf)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(body: &str) -> String {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body)
    }

    #[test]
    fn reads_single_frame() {
        let payload = frame(r#"{"type":"response","command":"initialize"}"#);
        let mut cursor = Cursor::new(payload.into_bytes());
        let msg = read_one(&mut cursor).unwrap();
        assert_eq!(msg["type"], "response");
        assert_eq!(msg["command"], "initialize");
    }

    #[test]
    fn reads_two_consecutive_frames() {
        let payload = format!(
            "{}{}",
            frame(r#"{"seq":1}"#),
            frame(r#"{"seq":2,"command":"next"}"#)
        );
        let mut cursor = Cursor::new(payload.into_bytes());
        let first = read_one(&mut cursor).unwrap();
        let second = read_one(&mut cursor).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(second["command"], "next");
    }

    #[test]
    fn ignores_unknown_headers() {
        let body = r#"{"ok":true}"#;
        let payload = format!(
            "Seq: 5\r\nSource: foo\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let mut cursor = Cursor::new(payload.into_bytes());
        let msg = read_one(&mut cursor).unwrap();
        assert_eq!(msg["ok"], true);
    }

    #[test]
    fn missing_content_length_errors() {
        let payload = b"Seq: 1\r\n\r\n";
        let mut cursor = Cursor::new(&payload[..]);
        let err = read_one(&mut cursor).unwrap_err();
        assert!(matches!(err, DapError::BadHeader(_)));
    }

    #[test]
    fn send_message_writes_framed() {
        let msg = serde_json::json!({"type": "request", "command": "ping"});
        let out: Vec<u8> = Vec::new();
        let transport = DapTransport::new(Cursor::new(Vec::<u8>::new()), out);
        transport.send_message(&msg).unwrap();
        let written = String::from_utf8(transport.writer.lock().unwrap().get_ref().clone()).unwrap();
        assert!(written.starts_with("Content-Length: "));
        assert!(written.contains("\r\n\r\n"));
        assert!(written.contains("\"ping\""));
    }
}
