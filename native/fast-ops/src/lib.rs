//! Fast operations for file system and text processing
//! Provides native performance for common file operations and text processing

use ignore::Walk;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum FastOpsError {
    #[error("Path not found: {0}")]
    PathNotFound(PathBuf),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Glob pattern error: {0}")]
    GlobError(String),
    #[error("Invalid file type")]
    InvalidFileType,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: PathBuf,
    pub file_type: FileType,
    pub size: u64,
    pub modified: i64,
    pub is_symlink: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileType {
    File,
    Directory,
    Symlink,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct FastFS {
    dir_cache: HashMap<PathBuf, Vec<FileEntry>>,
}

impl FastFS {
    pub fn new() -> Self {
        Self {
            dir_cache: HashMap::new(),
        }
    }

    /// Fast file discovery with glob patterns
    pub fn find_files(&mut self, pattern: &str, root: &Path) -> Result<Vec<FileEntry>, FastOpsError> {
        if !root.exists() {
            return Err(FastOpsError::PathNotFound(root.to_path_buf()));
        }

        // Check cache first
        let cache_key = root.to_path_buf();
        if let Some(cached) = self.dir_cache.get(&cache_key) {
            return Ok(Self::filter_by_pattern(cached, pattern));
        }

        // Walk directory and collect files
        let mut entries = Vec::new();

        let walker = Walk::new(root);
        for result in walker {
            if let Ok(entry) = result {
                let file_type = if entry.path().is_dir() {
                    FileType::Directory
                } else if entry.path().is_file() {
                    FileType::File
                } else if entry.path().is_symlink() {
                    FileType::Symlink
                } else {
                    FileType::Unknown
                };

                // Get metadata with proper error handling
                let metadata = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(_) => {
                        // If we can't get metadata from the entry, try directly
                        match std::fs::metadata(entry.path()) {
                            Ok(meta) => meta,
                            Err(_) => {
                                // For entries with problematic metadata, skip them or use defaults
                                continue;
                            }
                        }
                    }
                };

                let modified = metadata
                    .modified()
                    .map(|t| {
                        t.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as i64
                    })
                    .unwrap_or(0);

                entries.push(FileEntry {
                    path: entry.into_path(),
                    file_type,
                    size: metadata.len(),
                    modified,
                    is_symlink: metadata.is_symlink(),
                });
            }
        }

        // Cache results
        self.dir_cache.insert(cache_key.clone(), entries.clone());

        Ok(Self::filter_by_pattern(&entries, pattern))
    }

    /// Optimized mtime sorting
    pub fn sort_by_mtime(&self, files: &mut Vec<FileEntry>, descending: bool) {
        files.sort_by_key(|f| std::cmp::Reverse(f.modified));

        if !descending {
            files.reverse();
        }
    }

    /// Fast file type detection
    pub fn get_file_type(&self, path: &Path) -> Result<FileType, FastOpsError> {
        if !path.exists() {
            return Err(FastOpsError::PathNotFound(path.to_path_buf()));
        }

        let file_type = if path.is_dir() {
            FileType::Directory
        } else if path.is_file() {
            FileType::File
        } else if path.is_symlink() {
            FileType::Symlink
        } else {
            FileType::Unknown
        };

        Ok(file_type)
    }

    /// Clear directory cache
    pub fn clear_cache(&mut self) {
        self.dir_cache.clear();
    }

    // Helper functions
    fn filter_by_pattern(entries: &[FileEntry], pattern: &str) -> Vec<FileEntry> {
        let matcher = GlobMatcher::new(pattern);
        entries
            .iter()
            .filter(|entry| {
                // Match against both the full relative path and the file name,
                // so both "*.rs" and "src/*.rs" style patterns work.
                let path_str = entry.path.to_string_lossy();
                let name = entry.path.file_name().map(|f| f.to_string_lossy());
                matcher.matches(&path_str)
                    || name.map(|n| matcher.matches(&n)).unwrap_or(false)
            })
            .cloned()
            .collect()
    }
}

/// Minimal glob matcher supporting `*` (any chars, no path sep crossing),
/// `**` (any chars including separators), and `?` (single char).
/// Matching is case-insensitive, mirroring the previous `contains` behavior
/// but with correct wildcard semantics.
#[derive(Clone, Debug)]
struct GlobMatcher {
    tokens: Vec<Token>,
}

#[derive(Clone, Debug)]
enum Token {
    Lit(String),
    Star,      // *
    GlobStar,  // **
    Question,  // ?
}

impl GlobMatcher {
    fn new(pattern: &str) -> Self {
        let lower = pattern.to_lowercase();
        let mut tokens = Vec::new();
        let mut lit = String::new();
        let mut chars = lower.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '*' => {
                    if !lit.is_empty() {
                        tokens.push(Token::Lit(std::mem::take(&mut lit)));
                    }
                    if chars.peek() == Some(&'*') {
                        chars.next();
                        tokens.push(Token::GlobStar);
                    } else {
                        tokens.push(Token::Star);
                    }
                }
                '?' => {
                    if !lit.is_empty() {
                        tokens.push(Token::Lit(std::mem::take(&mut lit)));
                    }
                    tokens.push(Token::Question);
                }
                _ => lit.push(c),
            }
        }
        if !lit.is_empty() {
            tokens.push(Token::Lit(lit));
        }
        Self { tokens }
    }

    fn matches(&self, hay: &str) -> bool {
        let hay = hay.to_lowercase();
        glob_match(&self.tokens, 0, hay.as_bytes(), 0)
    }
}

/// Recursive glob matcher. Returns true if `tokens[tok_idx..]` matches
/// `input[in_idx..]`.
fn glob_match(tokens: &[Token], tok_idx: usize, input: &[u8], in_idx: usize) -> bool {
    if tok_idx == tokens.len() {
        return in_idx == input.len();
    }
    match &tokens[tok_idx] {
        Token::Lit(s) => {
            let sb = s.as_bytes();
            if in_idx + sb.len() > input.len() {
                return false;
            }
            if &input[in_idx..in_idx + sb.len()] == sb {
                glob_match(tokens, tok_idx + 1, input, in_idx + sb.len())
            } else {
                false
            }
        }
        Token::Question => {
            if in_idx < input.len() {
                glob_match(tokens, tok_idx + 1, input, in_idx + 1)
            } else {
                false
            }
        }
        Token::Star => {
            // `*` matches zero or more chars within a path segment (not '/').
            // Try every possible split point.
            let mut k = in_idx;
            loop {
                if glob_match(tokens, tok_idx + 1, input, k) {
                    return true;
                }
                if k >= input.len() || input[k] == b'/' {
                    return false;
                }
                k += 1;
            }
        }
        Token::GlobStar => {
            // `**` matches zero or more chars including separators.
            let mut k = in_idx;
            loop {
                if glob_match(tokens, tok_idx + 1, input, k) {
                    return true;
                }
                if k >= input.len() {
                    return false;
                }
                k += 1;
            }
        }
    }
}

impl Default for FastFS {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct FastText {
    ansi_cache: HashMap<String, Vec<AnsiSegment>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AnsiSegment {
    pub text: String,
    pub fg_color: Option<String>,
    pub bg_color: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

impl FastText {
    pub fn new() -> Self {
        Self {
            ansi_cache: HashMap::new(),
        }
    }

    /// ANSI-aware text processing
    pub fn parse_ansi(&mut self, text: &str) -> Vec<AnsiSegment> {
        // Check cache
        if let Some(cached) = self.ansi_cache.get(text) {
            return cached.clone();
        }

        let mut segments = Vec::new();
        let mut current_segment = AnsiSegment {
            text: String::new(),
            fg_color: None,
            bg_color: None,
            bold: false,
            italic: false,
            underline: false,
        };

        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            if chars[i] == '\x1b' && i + 1 < chars.len() && chars[i + 1] == '[' {
                // ANSI escape sequence
                let end = self.find_ansi_end(&chars, i + 2);
                let ansi_code: String = chars[i + 2..end].iter().collect();

                if !current_segment.text.is_empty() {
                    segments.push(current_segment.clone());
                    current_segment.text = String::new();
                }

                self.apply_ansi_code(&mut current_segment, &ansi_code);
                i = end + 1;
            } else {
                current_segment.text.push(chars[i]);
                i += 1;
            }
        }

        if !current_segment.text.is_empty() {
            segments.push(current_segment);
        }

        // Cache result
        self.ansi_cache.insert(text.to_string(), segments.clone());
        segments
    }

    /// Strip ANSI codes from text
    pub fn strip_ansi(&self, text: &str) -> String {
        let mut result = String::new();
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            if chars[i] == '\x1b' && i + 1 < chars.len() && chars[i + 1] == '[' {
                // Skip ANSI escape sequence
                i = self.find_ansi_end(&chars, i + 2) + 1;
            } else {
                result.push(chars[i]);
                i += 1;
            }
        }

        result
    }

    /// Count visible characters (excluding ANSI codes)
    pub fn visible_length(&self, text: &str) -> usize {
        self.strip_ansi(text).len()
    }

    // Helper functions
    fn find_ansi_end(&self, chars: &[char], start: usize) -> usize {
        let mut i = start;
        while i < chars.len() {
            match chars[i] {
                'm' | 'K' | 'H' | 'J' => return i,
                c if c.is_ascii_digit() || c == ';' => {}
                _ => return i,
            }
            i += 1;
        }
        i
    }

    fn apply_ansi_code(&self, segment: &mut AnsiSegment, code: &str) {
        let parts: Vec<&str> = code.split(';').collect();

        for part in parts {
            match part.trim() {
                "0" => {
                    // Reset
                    segment.fg_color = None;
                    segment.bg_color = None;
                    segment.bold = false;
                    segment.italic = false;
                    segment.underline = false;
                }
                "1" => segment.bold = true,
                "3" => segment.italic = true,
                "4" => segment.underline = true,
                "22" => segment.bold = false,
                "23" => segment.italic = false,
                "24" => segment.underline = false,
                "30" => segment.fg_color = Some("black".to_string()),
                "31" => segment.fg_color = Some("red".to_string()),
                "32" => segment.fg_color = Some("green".to_string()),
                "33" => segment.fg_color = Some("yellow".to_string()),
                "34" => segment.fg_color = Some("blue".to_string()),
                "35" => segment.fg_color = Some("magenta".to_string()),
                "36" => segment.fg_color = Some("cyan".to_string()),
                "37" => segment.fg_color = Some("white".to_string()),
                "40" => segment.bg_color = Some("black".to_string()),
                "41" => segment.bg_color = Some("red".to_string()),
                "42" => segment.bg_color = Some("green".to_string()),
                "43" => segment.bg_color = Some("yellow".to_string()),
                "44" => segment.bg_color = Some("blue".to_string()),
                "45" => segment.bg_color = Some("magenta".to_string()),
                "46" => segment.bg_color = Some("cyan".to_string()),
                "47" => segment.bg_color = Some("white".to_string()),
                _ => {}
            }
        }
    }
}

impl Default for FastText {
    fn default() -> Self {
        Self::new()
    }
}

// WASM exports
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmFastFS {
    inner: FastFS,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmFastFS {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: FastFS::new(),
        }
    }

    #[wasm_bindgen]
    pub fn find_files(&mut self, pattern: &str, root: &str) -> Result<JsValue, JsValue> {
        self.inner
            .find_files(pattern, Path::new(root))
            .map(|entries| {
                serde_wasm_bindgen::to_value(&entries).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn sort_by_mtime(&self, entries_js: JsValue, descending: bool) -> Result<JsValue, JsValue> {
        let mut entries: Vec<FileEntry> = serde_wasm_bindgen::from_value(entries_js)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        self.inner.sort_by_mtime(&mut entries, descending);

        serde_wasm_bindgen::to_value(&entries)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn get_file_type(&self, path: &str) -> Result<JsValue, JsValue> {
        self.inner
            .get_file_type(Path::new(path))
            .map(|file_type| {
                serde_wasm_bindgen::to_value(&file_type).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn clear_cache(&mut self) {
        self.inner.clear_cache();
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmFastText {
    inner: FastText,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmFastText {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: FastText::new(),
        }
    }

    #[wasm_bindgen]
    pub fn parse_ansi(&mut self, text: &str) -> Result<JsValue, JsValue> {
        let segments = self.inner.parse_ansi(text);
        serde_wasm_bindgen::to_value(&segments)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn strip_ansi(&self, text: &str) -> String {
        self.inner.strip_ansi(text)
    }

    #[wasm_bindgen]
    pub fn visible_length(&self, text: &str) -> usize {
        self.inner.visible_length(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fastfs_find_files() {
        let mut fastfs = FastFS::new();
        // Point at this crate's src/ directory so the walk reliably finds .rs
        // files regardless of the host's gitignore configuration.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

        let results = fastfs.find_files("*.rs", &root);
        assert!(results.is_ok(), "find_files returned err: {:?}", results.err());

        let files = results.unwrap();
        // Should find at least this test file
        assert!(!files.is_empty(), "expected to find .rs files under src/");
    }

    #[test]
    fn test_glob_matcher() {
        let m = GlobMatcher::new("*.rs");
        assert!(m.matches("lib.rs"));
        assert!(m.matches("src/lib.rs") == false, // `*` must not cross '/'
            "`*` should not cross path separators");
        assert!(!m.matches("lib.ts"));

        let m = GlobMatcher::new("**/*.rs");
        // `**/*.rs` requires a path separator, so it matches nested files but
        // not a bare top-level name.
        assert!(m.matches("src/lib.rs"));
        assert!(m.matches("a/b/c/lib.rs"));
        assert!(!m.matches("lib.rs"));

        let m = GlobMatcher::new("foo?.txt");
        assert!(m.matches("foo1.txt"));
        assert!(!m.matches("foo.txt"));
    }

    #[test]
    fn test_fastfs_sort_by_mtime() {
        let fastfs = FastFS::new();
        let mut files = vec![
            FileEntry {
                path: PathBuf::from("test1.txt"),
                file_type: FileType::File,
                size: 100,
                modified: 1000,
                is_symlink: false,
            },
            FileEntry {
                path: PathBuf::from("test2.txt"),
                file_type: FileType::File,
                size: 200,
                modified: 2000,
                is_symlink: false,
            },
        ];

        fastfs.sort_by_mtime(&mut files, true);
        assert_eq!(files[0].modified, 2000); // Descending order
    }

    #[test]
    fn test_fastfs_get_file_type() {
        let fastfs = FastFS::new();
        let file_type = fastfs.get_file_type(Path::new("Cargo.toml")).unwrap();
        assert_eq!(file_type, FileType::File);
    }

    #[test]
    fn test_fasttext_parse_ansi() {
        let mut fasttext = FastText::new();
        let text = "\x1b[31mRed text\x1b[0m Normal text";

        let segments = fasttext.parse_ansi(text);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].fg_color, Some("red".to_string()));
        assert_eq!(segments[1].fg_color, None); // Reset
    }

    #[test]
    fn test_fasttext_strip_ansi() {
        let fasttext = FastText::new();
        let text = "\x1b[31mRed text\x1b[0m Normal text";

        let stripped = fasttext.strip_ansi(text);
        assert_eq!(stripped, "Red text Normal text");
        assert!(!stripped.contains('\x1b'));
    }

    #[test]
    fn test_fasttext_visible_length() {
        let fasttext = FastText::new();
        let text = "\x1b[31mRed text\x1b[0m";

        let visible_len = fasttext.visible_length(text);
        assert_eq!(visible_len, 8); // "Red text"
    }
}
