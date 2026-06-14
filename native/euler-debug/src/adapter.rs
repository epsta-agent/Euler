//! DAP adapter detection and launch.
//!
//! Given a debug target (a file or program), pick the right DAP adapter and
//! produce the `Command` that starts it. Only adapters that are actually
//! installed are selected, so callers always get a runnable command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The kind of adapter, mirroring the languages Euler targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdapterKind {
    /// Python via `debugpy` (`python -m debugpy.adapter`).
    Python,
    /// Native code (C/C++/Rust) via `lldb-dap` or `codelldb`.
    Lldb,
    /// Go via `dlv dap`.
    Go,
    /// Node.js / JavaScript via `node --inspect`-style adapter.
    Node,
}

impl AdapterKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AdapterKind::Python => "python",
            AdapterKind::Lldb => "lldb",
            AdapterKind::Go => "go",
            AdapterKind::Node => "node",
        }
    }
}

/// A fully resolved adapter: the kind plus the program + args to launch it.
#[derive(Debug, Clone)]
pub struct AdapterSpec {
    pub kind: AdapterKind,
    pub program: String,
    pub args: Vec<String>,
}

/// Detect the adapter to use for a target.
///
/// Detection is content-driven: the target's extension determines the
/// language. The caller may also force a kind via `force`. If the detected
/// adapter's binary is not installed, `Err` is returned with an actionable
/// message.
pub fn detect_adapter(target: &str, force: Option<&str>) -> Result<AdapterSpec, String> {
    let kind = match force {
        Some(f) => parse_kind(f)?,
        None => infer_kind(target)?,
    };

    match kind {
        AdapterKind::Python => {
            let python = which("python3").or_else(|| which("python")).ok_or_else(|| {
                "python not found on PATH; install Python and debugpy (pip install debugpy)".to_string()
            })?;
            // Confirm debugpy is importable so we fail fast with a clear error
            // instead of an opaque adapter crash later.
            if !debugpy_available(&python) {
                return Err(format!(
                    "debugpy not found for {python}; install it with `pip install debugpy`"
                ));
            }
            Ok(AdapterSpec {
                kind,
                program: python,
                args: vec!["-m".into(), "debugpy.adapter".into()],
            })
        }
        AdapterKind::Lldb => {
            // Prefer lldb-dap (ships with LLVM/LLDB); fall back to codelldb.
            if let Some(prog) = which("lldb-dap").or_else(|| which("lldb-vscode")) {
                return Ok(AdapterSpec {
                    kind,
                    program: prog,
                    args: vec![],
                });
            }
            if let Some(prog) = which("codelldb") {
                return Ok(AdapterSpec {
                    kind,
                    program: prog,
                    args: vec![],
                });
            }
            Err(
                "no LLDB DAP adapter found; install lldb-dap (LLVM) or codelldb".to_string(),
            )
        }
        AdapterKind::Go => {
            let prog = which("dlv").ok_or_else(|| {
                "dlv (delve) not found on PATH; install it with `go install github.com/go-delve/delve/cmd/dlv@latest`".to_string()
            })?;
            Ok(AdapterSpec {
                kind,
                program: prog,
                args: vec!["dap".into()],
            })
        }
        AdapterKind::Node => {
            let prog = which("node").ok_or_else(|| {
                "node not found on PATH; install Node.js".to_string()
            })?;
            Ok(AdapterSpec {
                kind,
                program: prog,
                args: vec![],
            })
        }
    }
}

/// Spawn an adapter as a child process with piped stdio, returning the child.
pub fn spawn_adapter(spec: &AdapterSpec) -> Result<std::process::Child, String> {
    Command::new(&spec.program)
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn adapter {} {}: {}", spec.program, spec.args.join(" "), e))
}

fn parse_kind(s: &str) -> Result<AdapterKind, String> {
    match s.trim().to_lowercase().as_str() {
        "python" | "debugpy" | "py" => Ok(AdapterKind::Python),
        "lldb" | "lldb-dap" | "lldb-vscode" | "codelldb" | "c" | "cpp" | "rust" | "rs" => {
            Ok(AdapterKind::Lldb)
        }
        "go" | "dlv" | "golang" => Ok(AdapterKind::Go),
        "node" | "js" | "javascript" | "ts" | "typescript" => Ok(AdapterKind::Node),
        other => Err(format!(
            "unknown adapter '{other}'; valid: python, lldb, go, node"
        )),
    }
}

fn infer_kind(target: &str) -> Result<AdapterKind, String> {
    let ext = Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "py" => Ok(AdapterKind::Python),
        "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "rs" | "o" | "out" | "" => {
            // Empty extension: assume a compiled binary. Otherwise native by
            // extension.
            Ok(AdapterKind::Lldb)
        }
        "go" => Ok(AdapterKind::Go),
        "js" | "mjs" | "cjs" | "ts" => Ok(AdapterKind::Node),
        other => Err(format!(
            "cannot infer adapter from extension '.{other}'; pass an explicit adapter (python, lldb, go, node)"
        )),
    }
}

fn debugpy_available(python: &str) -> bool {
    Command::new(python)
        .args(["-c", "import debugpy"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Minimal PATH lookup (no third-party `which` dep).
pub fn which(program: &str) -> Option<String> {
    // Allow absolute/relative paths to short-circuit.
    let p = Path::new(program);
    if p.is_absolute() || program.contains('/') {
        if p.exists() {
            return Some(program.to_string());
        }
        return None;
    }

    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate: PathBuf = dir.join(program);
        if candidate.is_file() {
            // On unix, ensure it's executable.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = candidate.metadata() {
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
            }
            #[cfg(not(unix))]
            {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_python() {
        assert_eq!(infer_kind("main.py").unwrap(), AdapterKind::Python);
    }

    #[test]
    fn infers_go() {
        assert_eq!(infer_kind("main.go").unwrap(), AdapterKind::Go);
    }

    #[test]
    fn infers_node() {
        assert_eq!(infer_kind("app.js").unwrap(), AdapterKind::Node);
        assert_eq!(infer_kind("app.ts").unwrap(), AdapterKind::Node);
    }

    #[test]
    fn infers_native() {
        assert_eq!(infer_kind("main.rs").unwrap(), AdapterKind::Lldb);
        assert_eq!(infer_kind("./bin/myapp").unwrap(), AdapterKind::Lldb);
    }

    #[test]
    fn rejects_unknown_extension() {
        assert!(infer_kind("weird.xyz").is_err());
    }

    #[test]
    fn parses_forced_kinds() {
        assert_eq!(parse_kind("python").unwrap(), AdapterKind::Python);
        assert_eq!(parse_kind("LLDB").unwrap(), AdapterKind::Lldb);
        assert_eq!(parse_kind("go").unwrap(), AdapterKind::Go);
        assert_eq!(parse_kind("node").unwrap(), AdapterKind::Node);
        assert!(parse_kind("rust-lang").is_err());
    }
}
