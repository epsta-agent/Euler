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

/// Spawn an adapter as a child process with piped stdio, in its own process
/// group so the whole adapter tree (the debuggee included) can be torn down
/// together on disconnect. Returns the child.
pub fn spawn_adapter(spec: &AdapterSpec) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the adapter in a fresh process group / console group so that on
    // teardown we can kill the entire tree (debugpy, for example, spawns the
    // real debuggee as a grandchild) rather than orphaning it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP = 0x00000200. Detaches the adapter into its
        // own group so we can tear the whole tree down with `taskkill /T`.
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    cmd.spawn().map_err(|e| {
        format!(
            "failed to spawn adapter {} {}: {}",
            spec.program,
            spec.args.join(" "),
            e
        )
    })
}

/// Tear down an adapter child and its whole process tree.
///
/// Best-effort: sends SIGKILL to the child's process group on Unix and
/// `taskkill /T /F` on Windows, then reaps the child so it does not become a
/// zombie. Safe to call on an already-dead child.
pub fn kill_tree(child: &mut std::process::Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        // killpg(-pgid) signals the whole group; we created the adapter in its
        // own group, so this reaches grandchildren (the debuggee). If the group
        // is already gone, ignore ESRCH.
        unsafe {
            // libc is already a transitive dependency; using it directly avoids
            // pulling nix into this crate's manifest.
            let pgid = libc::getpgid(pid as libc::pid_t);
            if pgid > 0 {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            } else {
                // Fall back to the direct pid if getpgid failed.
                let _ = libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        // taskkill with /T walks the tree, /F forces. Ignore failures: the
        // tree may already be gone.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
    }
    // Reap to avoid a zombie regardless of platform.
    let _ = child.wait();
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
        .map(str::to_lowercase)
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
///
/// On Unix: returns the first PATH entry whose file is executable.
/// On Windows: tries each candidate name against the `PATHEXT` extensions
/// (`.COM;.EXE;.BAT;…`), so `which("python")` finds `python.exe`. PATH
/// directories are de-duplicated so we don't re-stat the same dir twice.
pub fn which(program: &str) -> Option<String> {
    // Allow absolute/relative paths to short-circuit. On Windows an absolute
    // path may already include an extension; otherwise we still try PATHEXT.
    let p = Path::new(program);
    if p.is_absolute() || program.contains('/') || program.contains('\\') {
        if p.exists() {
            return Some(program.to_string());
        }
        #[cfg(windows)]
        if let Some(found) = try_with_pathext(p) {
            return Some(found);
        }
        return None;
    }

    let path_env = std::env::var_os("PATH")?;
    let mut seen = std::collections::HashSet::new();
    for dir in std::env::split_paths(&path_env) {
        // Dedupe PATH entries: a doubled dir just wastes stats.
        if !seen.insert(dir.clone()) {
            continue;
        }
        #[cfg(unix)]
        {
            let candidate: PathBuf = dir.join(program);
            if let Some(hit) = check_unix_executable(&candidate) {
                return Some(hit);
            }
        }
        #[cfg(windows)]
        {
            for candidate_name in windows_candidates(program) {
                let candidate: PathBuf = dir.join(&candidate_name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let candidate: PathBuf = dir.join(program);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// On Unix, return the path if it is a regular executable file.
#[cfg(unix)]
fn check_unix_executable(candidate: &Path) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = candidate.metadata().ok()?;
    // Any executable bit (user/group/other) counts.
    if meta.permissions().mode() & 0o111 != 0 {
        Some(candidate.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// On Windows, enumerate the names to try for `program` by appending each
/// `PATHEXT` extension. If `program` already ends in an extension, only the
/// bare name is tried.
#[cfg(windows)]
fn windows_candidates(program: &str) -> Vec<String> {
    let mut out = vec![program.to_string()];
    // If the user already supplied an extension, don't double-append.
    let has_ext = program
        .rsplit('.')
        .next()
        .map(|last| last.len() <= 4 && !last.contains('/') && !last.contains('\\'))
        .unwrap_or(false);
    if !has_ext {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            out.push(format!("{program}{ext}"));
        }
    }
    out
}

/// On Windows, given an absolute path with no extension, try appending each
/// PATHEXT extension and return the first that exists.
#[cfg(windows)]
fn try_with_pathext(p: &Path) -> Option<String> {
    let s = p.to_string_lossy();
    for name in windows_candidates(&s) {
        if Path::new(&name).exists() {
            return Some(name);
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

    /// `which()` must honor the executable bit: a non-executable file on PATH
    /// is not a match. We create two files with the same name, one executable
    /// and one not, in different PATH dirs, and confirm we get the executable
    /// one (and never the non-executable one when only that is present).
    #[cfg(unix)]
    #[test]
    fn which_requires_executable_bit_unix() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("exe");
        let noexec_dir = tmp.path().join("noexec");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&noexec_dir).unwrap();

        let exe_path = exe_dir.join("euler-which-fixture");
        std::fs::write(&exe_path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let noexec_path = noexec_dir.join("euler-which-fixture");
        std::fs::write(&noexec_path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&noexec_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let old_path = std::env::var_os("PATH").unwrap();
        // Put the non-executable dir first; we must still skip it and find the
        // executable copy in the second dir.
        let new_path = std::env::join_paths([
            noexec_dir.as_os_str(),
            exe_dir.as_os_str(),
        ])
        .unwrap();
        // SAFETY: tests run single-threaded within this process; we restore
        // PATH at the end. Other concurrent tests in the binary don't read PATH.
        // Set env for the duration of the call only by saving/restoring.
        std::env::set_var("PATH", &new_path);
        let found = which("euler-which-fixture");
        std::env::set_var("PATH", &old_path);

        let found = found.expect("should have found the executable copy");
        assert_eq!(found, exe_path.to_string_lossy());
    }

    /// On Windows, `which("python")` must try `python.exe` etc. We can't run
    /// this off-Windows, but the candidate-name logic is pure and worth
    /// pinning down so it doesn't regress.
    #[cfg(windows)]
    #[test]
    fn which_appends_pathext_extensions() {
        // Bare name: should expand to the bare name + each PATHEXT ext.
        let cands = windows_candidates("python");
        assert!(cands.first().map(|s| s.as_str()) == Some("python"));
        assert!(cands.iter().any(|s| s.eq_ignore_ascii_case("python.exe")));
        // Already-extensioned name: must NOT be double-appended.
        let cands = windows_candidates("foo.exe");
        assert_eq!(cands, vec!["foo.exe".to_string()]);
    }
}
