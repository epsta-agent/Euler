//! PTY (Pseudo-Terminal) bridge for interactive shell support
//! Provides native PTY allocation and management.
//!
//! PTY operations require native platform APIs and are therefore not available
//! under the `wasm` feature target. The `wasm` feature exists only so the crate
//! still produces a valid library under WASM builds (no exports).

use std::time::Duration;
use thiserror::Error;

#[cfg(not(feature = "wasm"))]
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty};

#[derive(Error, Debug)]
pub enum PtyError {
    #[error("PTY creation failed: {0}")]
    CreationFailed(String),
    #[error("PTY read error: {0}")]
    ReadError(String),
    #[error("PTY write error: {0}")]
    WriteError(String),
    #[error("PTY resize error: {0}")]
    ResizeError(String),
}

/// Our own PtySize, intentionally distinct from `portable_pty::PtySize` to
/// avoid a duplicate-definition conflict when both are in scope.
#[derive(Clone, Debug)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        Self {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[cfg(not(feature = "wasm"))]
impl From<PtySize> for portable_pty::PtySize {
    fn from(size: PtySize) -> Self {
        portable_pty::PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PtyProcessInfo {
    pub command: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
}

/// Native PTY session. Unavailable under the `wasm` feature.
#[cfg(not(feature = "wasm"))]
pub struct PtySession {
    master: Box<dyn MasterPty>,
    writer: Option<Box<dyn std::io::Write + Send>>,
    child: Box<dyn Child>,
    info: PtyProcessInfo,
}

#[cfg(not(feature = "wasm"))]
impl PtySession {
    /// Create a new PTY session with the specified command.
    pub fn new(command: &str, args: &[&str], size: PtySize) -> Result<Self, PtyError> {
        let pty_system = native_pty_system();

        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }

        let pty_size: portable_pty::PtySize = size.into();
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| PtyError::CreationFailed(e.to_string()))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::CreationFailed(e.to_string()))?;

        // We can drop the slave after spawning; the child keeps a handle.
        drop(pair.slave);

        // Take the writer once and keep it for the lifetime of the session.
        // `take_writer` is a one-shot on some backends, so re-calling it on
        // every write would fail after the first.
        let writer = pair.master.take_writer().ok();

        Ok(Self {
            master: pair.master,
            writer,
            child,
            info: PtyProcessInfo {
                command: command.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                pid: None,
            },
        })
    }

    /// Create a new PTY session with the default shell.
    pub fn new_shell(size: PtySize) -> Result<Self, PtyError> {
        #[cfg(target_os = "macos")]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        #[cfg(target_os = "linux")]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

        #[cfg(target_os = "windows")]
        let shell = "cmd.exe".to_string();

        Self::new(&shell, &[], size)
    }

    /// Read from PTY with timeout.
    ///
    /// The cloned reader is a blocking `Box<dyn Read + Send>` with no
    /// settable timeout. To honor `timeout`, we race a reader thread against
    /// a deadline using an mpsc channel: if data arrives it is returned; if
    /// the deadline elapses first we return whatever was read (possibly empty).
    pub fn read(&mut self, timeout: Duration) -> Result<Vec<u8>, PtyError> {
        use std::io::Read;
        use std::sync::mpsc;
        use std::thread;

        let mut reader = self.master.try_clone_reader().map_err(|e| {
            PtyError::ReadError(format!("Failed to get reader: {}", e))
        })?;

        let (tx, rx) = mpsc::channel::<std::io::Result<Vec<u8>>>();
        thread::spawn(move || {
            let mut buffer = vec![0u8; 4096];
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = tx.send(Ok(Vec::new()));
                }
                Ok(n) => {
                    buffer.truncate(n);
                    let _ = tx.send(Ok(buffer));
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }
        });

        match rx.recv_timeout(timeout) {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(e)) => Err(PtyError::ReadError(format!("Read failed: {}", e))),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(Vec::new()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(Vec::new()),
        }
    }

    /// Write data to PTY.
    pub fn write(&mut self, data: &[u8]) -> Result<(), PtyError> {
        use std::io::Write;

        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| PtyError::WriteError("No PTY writer available".to_string()))?;

        writer
            .write_all(data)
            .map_err(|e| PtyError::WriteError(format!("Write failed: {}", e)))?;

        writer
            .flush()
            .map_err(|e| PtyError::WriteError(format!("Flush failed: {}", e)))?;

        Ok(())
    }

    /// Resize PTY.
    pub fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        let pty_size: portable_pty::PtySize = size.into();
        self.master
            .resize(pty_size)
            .map_err(|e| PtyError::ResizeError(e.to_string()))
    }

    /// Check if the child process is still running.
    /// `try_wait` returns `Ok(Some(status))` when the child has exited and
    /// `Ok(None)` while it is still running, so "alive" = the None case.
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }

    /// Get process information.
    pub fn info(&self) -> &PtyProcessInfo {
        &self.info
    }

    /// Send Ctrl+C to the PTY.
    pub fn send_ctrl_c(&mut self) -> Result<(), PtyError> {
        self.write(&[0x03]) // ASCII ETX (End of Text)
    }

    /// Send EOF to the PTY.
    pub fn send_eof(&mut self) -> Result<(), PtyError> {
        self.write(&[0x04]) // ASCII EOT (End of Transmission)
    }

    /// Get current PTY size. This crate does not currently query the kernel
    /// for the live size, so the default is returned.
    pub fn get_size(&self) -> Result<PtySize, PtyError> {
        Ok(PtySize::default())
    }
}

#[cfg(not(feature = "wasm"))]
impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.try_wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_size_default() {
        let s = PtySize::default();
        assert_eq!(s.rows, 24);
        assert_eq!(s.cols, 80);
    }

    #[cfg(all(unix, not(feature = "wasm")))]
    #[test]
    fn test_pty_session_creation() {
        let session = PtySession::new_shell(PtySize::default()).unwrap();
        let cmd = &session.info().command;
        assert!(cmd == "/bin/bash" || cmd == "/bin/zsh" || cmd.contains("zsh") || cmd.contains("bash"));
    }

    #[cfg(all(unix, not(feature = "wasm")))]
    #[test]
    fn test_pty_resize() {
        let mut session = PtySession::new_shell(PtySize::default()).unwrap();
        let new_size = PtySize {
            rows: 40,
            cols: 120,
            ..Default::default()
        };
        assert!(session.resize(new_size).is_ok());
    }

    #[cfg(all(unix, not(feature = "wasm")))]
    #[test]
    fn test_pty_write_and_ctrl_c() {
        // Both writes use the session's stored writer, so a second write
        // (via send_ctrl_c) must succeed after the first.
        let mut session = PtySession::new_shell(PtySize::default()).unwrap();
        assert!(session.write(b"echo 'test'\n").is_ok());
        assert!(session.send_ctrl_c().is_ok());
    }
}
