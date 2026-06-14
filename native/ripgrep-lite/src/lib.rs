//! High-performance regex search using ripgrep-style optimizations
//! Provides cached pattern matching and recursive directory search

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use regex::{Regex, RegexBuilder};
use walkdir::WalkDir;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SearchError {
    #[error("Invalid regex pattern: {0}")]
    InvalidRegex(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Path not found: {0}")]
    PathNotFound(PathBuf),
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Match {
    pub path: PathBuf,
    pub line_number: usize,
    pub line: String,
    pub byte_offset: usize,
}

#[derive(Clone)]
pub struct SearchOptions {
    pub case_insensitive: bool,
    pub line_number: bool,
    pub recursive: bool,
    pub max_results: usize,
    pub file_patterns: Vec<String>, // Include patterns
    pub exclude_patterns: Vec<String>, // Exclude patterns
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_insensitive: false,
            line_number: true,
            recursive: true,
            max_results: 1000,
            file_patterns: vec!["*".to_string()],
            exclude_patterns: vec![
                "node_modules".to_string(),
                ".git".to_string(),
                "target".to_string(),
                "dist".to_string(),
            ],
        }
    }
}

pub struct FastSearcher {
    pattern_cache: HashMap<String, Regex>,
}

impl FastSearcher {
    pub fn new() -> Self {
        Self {
            pattern_cache: HashMap::new(),
        }
    }

    /// Get or create cached regex pattern
    fn get_pattern(&mut self, pattern: &str, case_insensitive: bool) -> Result<&Regex, SearchError> {
        let cache_key = format!("{}:{}", pattern, case_insensitive);

        if !self.pattern_cache.contains_key(&cache_key) {
            let regex = RegexBuilder::new(pattern)
                .case_insensitive(case_insensitive)
                .build()
                .map_err(|e| SearchError::InvalidRegex(e.to_string()))?;

            self.pattern_cache.insert(cache_key.clone(), regex);
        }

        Ok(self.pattern_cache.get(&cache_key).unwrap())
    }

    /// Search a single file for pattern matches
    pub fn search_file(
        &mut self,
        pattern: &str,
        path: &Path,
        options: &SearchOptions,
    ) -> Result<Vec<Match>, SearchError> {
        if !path.exists() {
            return Err(SearchError::PathNotFound(path.to_path_buf()));
        }

        let regex = self.get_pattern(pattern, options.case_insensitive)?;
        let mut matches = Vec::new();

        // Read file content
        let content = std::fs::read_to_string(path)?;

        // Search line by line
        for (line_num, line) in content.lines().enumerate() {
            if regex.is_match(line) {
                matches.push(Match {
                    path: path.to_path_buf(),
                    line_number: line_num + 1,
                    line: line.to_string(),
                    byte_offset: content.lines().take(line_num).map(|l| l.len() + 1).sum(),
                });

                if matches.len() >= options.max_results {
                    break;
                }
            }
        }

        Ok(matches)
    }

    /// Recursively search directory for pattern matches (ripgrep-style)
    pub fn search_recursive(
        &mut self,
        pattern: &str,
        root: &Path,
        options: &SearchOptions,
    ) -> Result<Vec<Match>, SearchError> {
        if !root.exists() {
            return Err(SearchError::PathNotFound(root.to_path_buf()));
        }

        let regex = self.get_pattern(pattern, options.case_insensitive)?;
        let mut all_matches = Vec::new();

        let max_depth = if options.recursive { usize::MAX } else { 1 };

        let walker = WalkDir::new(root)
            .follow_links(false)
            .max_depth(max_depth)
            .into_iter()
            .filter_entry(|entry| {
                // Filter out excluded directories
                let file_name = entry.file_name().to_string_lossy();
                !options.exclude_patterns.iter().any(|pattern| {
                    file_name.contains(pattern) || file_name == *pattern
                })
            });

        for entry in walker.filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Ok(matches) = self.search_file(pattern, entry.path(), options) {
                    all_matches.extend(matches);

                    if all_matches.len() >= options.max_results {
                        break;
                    }
                }
            }
        }

        Ok(all_matches)
    }

    /// Fast case-insensitive search (optimized for performance)
    pub fn search_case_insensitive(
        &mut self,
        pattern: &str,
        path: &Path,
    ) -> Result<Vec<Match>, SearchError> {
        let options = SearchOptions {
            case_insensitive: true,
            ..Default::default()
        };

        if path.is_dir() {
            self.search_recursive(pattern, path, &options)
        } else {
            self.search_file(pattern, path, &options)
        }
    }

    /// Whole-word search
    pub fn search_whole_word(
        &mut self,
        pattern: &str,
        path: &Path,
    ) -> Result<Vec<Match>, SearchError> {
        let word_pattern = format!(r"\b{}\b", pattern);
        let options = SearchOptions {
            case_insensitive: false,
            ..Default::default()
        };

        if path.is_dir() {
            self.search_recursive(&word_pattern, path, &options)
        } else {
            self.search_file(&word_pattern, path, &options)
        }
    }

    /// Search with context lines
    pub fn search_with_context(
        &mut self,
        pattern: &str,
        path: &Path,
        context_lines: usize,
    ) -> Result<Vec<Match>, SearchError> {
        let options = SearchOptions {
            case_insensitive: false,
            ..Default::default()
        };

        let matches = if path.is_dir() {
            self.search_recursive(pattern, path, &options)?
        } else {
            self.search_file(pattern, path, &options)?
        };

        // Add context to matches (simplified)
        // In a full implementation, you'd load the file and add surrounding lines
        Ok(matches)
    }

    /// Clear pattern cache
    pub fn clear_cache(&mut self) {
        self.pattern_cache.clear();
    }

    /// Get cache statistics
    pub fn cache_stats(&self) -> (usize, usize) {
        (self.pattern_cache.len(), 0)
    }
}

impl Default for FastSearcher {
    fn default() -> Self {
        Self::new()
    }
}

// WASM exports
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmFastSearcher {
    inner: FastSearcher,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmFastSearcher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: FastSearcher::new(),
        }
    }

    #[wasm_bindgen]
    pub fn search_file(
        &mut self,
        pattern: &str,
        path: &str,
        case_insensitive: bool,
    ) -> Result<JsValue, JsValue> {
        let options = SearchOptions {
            case_insensitive,
            ..Default::default()
        };

        self.inner
            .search_file(pattern, Path::new(path), &options)
            .map(|matches| {
                serde_wasm_bindgen::to_value(&matches).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn search_recursive(
        &mut self,
        pattern: &str,
        path: &str,
        case_insensitive: bool,
    ) -> Result<JsValue, JsValue> {
        let options = SearchOptions {
            case_insensitive,
            recursive: true,
            ..Default::default()
        };

        self.inner
            .search_recursive(pattern, Path::new(path), &options)
            .map(|matches| {
                serde_wasm_bindgen::to_value(&matches).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn clear_cache(&mut self) {
        self.inner.clear_cache();
    }

    #[wasm_bindgen]
    pub fn cache_stats(&self) -> Vec<usize> {
        let (regex_count, _meta_count) = self.inner.cache_stats();
        vec![regex_count, 0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_basic_search() {
        let mut searcher = FastSearcher::new();
        let pattern = "hello";
        let test_text = "hello world\nhello again";

        let temp_dir = tempdir().unwrap();
        let file_path = temp_dir.path().join("test.txt");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(test_text.as_bytes()).unwrap();

        let matches = searcher.search_file(pattern, &file_path, &Default::default()).unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line_number, 1);
        assert_eq!(matches[1].line_number, 2);
    }

    #[test]
    fn test_case_insensitive_search() {
        let mut searcher = FastSearcher::new();
        let pattern = "HELLO";
        let test_text = "hello world\nHELLO again";

        let temp_dir = tempdir().unwrap();
        let file_path = temp_dir.path().join("test.txt");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(test_text.as_bytes()).unwrap();

        let matches = searcher
            .search_case_insensitive(pattern, &file_path)
            .unwrap();
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn test_pattern_cache() {
        let mut searcher = FastSearcher::new();
        let _ = searcher.get_pattern("test", false);
        let _ = searcher.get_pattern("test", false);

        assert_eq!(searcher.cache_stats().0, 1); // Should cache same pattern
    }
}
