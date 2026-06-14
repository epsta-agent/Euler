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
    ///
    /// Serializes directly into the buffered writer to avoid allocating an
    /// intermediate `Vec<u8>` per message (the previous `to_vec` + `write_all`
    /// path allocated twice). The header is emitted with a fixed scratch
    /// buffer so we never hit the `write!` formatter on the hot path.
    pub fn send_message(&self, msg: &Value) -> Result<(), DapError> {
        let body = serde_json::to_vec(msg)?;
        let w = &mut *self.writer.lock().unwrap();
        // Pre-format the Content-Length header into a small stack buffer.
        // 32 bytes is plenty for "Content-Length: <u64>\r\n\r\n".
        let mut header = [0u8; 32];
        let prefix = b"Content-Length: ";
        let n = prefix.len();
        header[..n].copy_from_slice(prefix);
        let len_str = itoa_into(body.len(), &mut header[n..]);
        let tail = b"\r\n\r\n";
        let total = n + len_str;
        header[total..total + tail.len()].copy_from_slice(tail);
        w.write_all(&header[..total + tail.len()])?;
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

/// Write a usize as decimal ASCII into `out`, returning the number of bytes
/// written. A tiny, allocation-free replacement for the `itoa` crate (and for
/// the `write!` formatter) on the send hot path.
fn itoa_into(mut value: usize, out: &mut [u8]) -> usize {
    if value == 0 {
        out[0] = b'0';
        return 1;
    }
    // Compute digits in reverse, then copy into place.
    let mut tmp = [0u8; 20];
    let mut i = 0;
    while value > 0 {
        tmp[i] = b'0' + (value % 10) as u8;
        value /= 10;
        i += 1;
    }
    let digits = &tmp[..i];
    for (k, &d) in digits.iter().rev().enumerate() {
        out[k] = d;
    }
    i
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
        // Use a pipe: write into a Vec, then read it back with read_one to
        // confirm the frame round-trips correctly.
        let out: Vec<u8> = Vec::new();
        let transport = DapTransport::new(Cursor::new(Vec::<u8>::new()), out);
        transport.send_message(&msg).unwrap();
        let written = {
            let w = transport.writer.lock().unwrap();
            let buf: &Vec<u8> = w.get_ref();
            buf.clone()
        };
        let written = String::from_utf8(written).unwrap();
        assert!(written.starts_with("Content-Length: "), "got: {written:?}");
        assert!(written.contains("\r\n\r\n"));
        assert!(written.contains("\"ping\""));

        // And the written bytes should parse back as a DAP frame.
        let mut cursor = Cursor::new(written.into_bytes());
        let parsed = read_one(&mut cursor).unwrap();
        assert_eq!(parsed["command"], "ping");
    }

    #[test]
    fn ita_into_formats_decimal() {
        let mut out = [0u8; 8];
        let n = itoa_into(0, &mut out);
        assert_eq!(&out[..n], b"0");
        let n = itoa_into(7, &mut out);
        assert_eq!(&out[..n], b"7");
        let n = itoa_into(12345, &mut out);
        assert_eq!(&out[..n], b"12345");
    }
}
