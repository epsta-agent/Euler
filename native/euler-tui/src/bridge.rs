//! Bridge — manages the TypeScript agent subprocess.
//!
//! Spawns `bun src/headless.ts`, sends `Request`s on its stdin, and reads
//! `AgentMessage`s (Responses + Events) from its stdout on a dedicated task.
//! Each parsed message is forwarded to the app via an mpsc channel.
//!
//! All child stderr is captured for diagnostics (logged at debug). We never
//! write anything but JSON requests to the child's stdin, and we never read
//! anything but JSON lines from its stdout — the protocol is strict.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use crate::protocol::{AgentMessage, InitializeConfig, Request, Response};

/// The handle to a live agent subprocess.
pub struct Bridge {
    child: Child,
    stdin: ChildStdin,
    /// Receiver for messages parsed from the child's stdout. Behind an Option
    /// so the main loop can `.take()` it for the pump task (the struct impls
    /// Drop, so a direct move is forbidden).
    pub rx: Option<mpsc::Receiver<AgentMessage>>,
}

impl Bridge {
    /// Spawn the headless agent. `project_root` is the euler repo root (where
    /// src/headless.ts lives). `headless_path` defaults to `src/headless.ts`.
    ///
    /// Not async: `tokio::process::Command::spawn()` is synchronous (it forks
    /// immediately), and nothing in the body awaits — so there's no reason for
    /// the caller to `.await` this. Marking it async was just noise.
    pub fn spawn(project_root: PathBuf) -> Result<Self> {
        let headless = project_root.join("src").join("headless.ts");
        let mut child = tokio::process::Command::new("bun")
            .arg(&headless)
            .current_dir(&project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn `bun {}`", headless.display()))?;

        let stdin = child
            .stdin
            .take()
            .context("child has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("child has no stdout")?;

        let (tx, rx) = mpsc::channel::<AgentMessage>(256);

        // Reader task: parse stdout line-by-line for the lifetime of the child.
        tokio::spawn(reader_task(stdout, tx));

        // Stderr drain task: best-effort capture for diagnostics. We just
        // discard it in normal operation; a debug build could log it.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_stderr(stderr));
        }

        Ok(Self {
            child,
            stdin,
            rx: Some(rx),
        })
    }

    /// Take ownership of the message receiver (for the pump task). The bridge
    /// keeps stdin + child handles for sending requests and cleanup.
    pub fn take_rx(&mut self) -> Option<mpsc::Receiver<AgentMessage>> {
        self.rx.take()
    }

    /// Send an initialize request and wait for the response.
    pub async fn initialize(&mut self, config: InitializeConfig) -> Result<Response> {
        self.send_request(&Request::Initialize { config }).await?;
        self.await_response().await
    }

    /// Send a process request (events will stream in via `rx`).
    pub async fn process(&mut self, message: &str) -> Result<()> {
        self.send_request(&Request::Process {
            message: message.to_string(),
        })
        .await
    }

    /// Send an interrupt request. This asks the agent to abort the in-flight
    /// model request for the current turn. The agent acknowledges with a
    /// Response (ok:false, error:"interrupted") which the main loop receives
    /// through the normal pump and uses to clear `bridge_busy`.
    pub async fn interrupt(&mut self) -> Result<()> {
        self.send_request(&Request::Interrupt).await
    }

    /// Send a reset request (/clear): drop the agent's in-memory conversation.
    /// The subprocess stays alive; only history is cleared.
    pub async fn reset(&mut self) -> Result<()> {
        self.send_request(&Request::Reset).await
    }

    /// Send a shutdown request (the child exits 0).
    pub async fn shutdown(&mut self) -> Result<()> {
        self.send_request(&Request::Shutdown).await
    }

    /// Wait for the next Response message, skipping any Events (the caller
    /// should be draining `rx` for events concurrently, but for initialize the
    /// only message we expect is the response).
    pub async fn await_response(&mut self) -> Result<Response> {
        let rx = self
            .rx
            .as_mut()
            .context("receiver already taken")?;
        while let Some(msg) = rx.recv().await {
            if let AgentMessage::Response(r) = msg {
                return Ok(r);
            }
            // Events before the initialize response are unexpected but harmless;
            // skip them.
        }
        anyhow::bail!("agent subprocess closed before responding")
    }

    async fn send_request(&mut self, req: &Request) -> Result<()> {
        let mut line = serde_json::to_string(req).context("encode request")?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("write request to agent stdin")?;
        self.stdin.flush().await.context("flush agent stdin")?;
        Ok(())
    }

    /// Hard-kill the child if it's still running. Kept as an escape hatch even
    /// though the normal shutdown path uses `shutdown()` + `kill_on_drop`.
    #[allow(dead_code)]
    pub fn kill(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // kill_on_drop(true) handles this, but be explicit.
        let _ = self.child.start_kill();
    }
}

/// Read stdout lines, parse each, forward over the channel.
async fn reader_task(stdout: ChildStdout, tx: mpsc::Sender<AgentMessage>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            // EOF (child closed stdout) and read errors both end the pump.
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Some(msg) = AgentMessage::parse(&buf) {
                    if tx.send(msg).await.is_err() {
                        // Receiver dropped — app is shutting down.
                        break;
                    }
                }
                // Unparseable lines are ignored (the host guarantees JSON).
            }
        }
    }
}

/// Drain stderr to prevent the child blocking on a full pipe.
async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                // Optionally surface in a debug log pane. Discarded for now.
            }
        }
    }
}
