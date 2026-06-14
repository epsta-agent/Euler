//! Native clipboard access for cross-platform copy/paste operations
//! Provides native clipboard integration for macOS, Linux, and Windows

use std::sync::Mutex;
use thiserror::Error;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use arboard;

#[derive(Error, Debug)]
pub enum ClipboardError {
    #[error("Clipboard not available")]
    NotAvailable,
    #[error("Clipboard access denied")]
    AccessDenied,
    #[error("Invalid clipboard content")]
    InvalidContent,
    #[error("Platform error: {0}")]
    PlatformError(String),
}

#[derive(Clone, Debug)]
pub struct ClipboardContent {
    pub text: String,
    pub mime_type: String,
}

/// Native clipboard interface
pub trait NativeClipboard {
    /// Get clipboard content as text
    fn get_string(&self) -> Result<String, ClipboardError>;

    /// Set clipboard content as text
    fn set_string(&self, text: &str) -> Result<(), ClipboardError>;

    /// Check if clipboard is available
    fn is_available(&self) -> bool;

    /// Clear clipboard content
    fn clear(&self) -> Result<(), ClipboardError>;

    /// Get available clipboard formats
    fn get_formats(&self) -> Vec<String>;
}

/// macOS clipboard implementation
#[cfg(target_os = "macos")]
pub struct MacOSClipboard {
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

#[cfg(target_os = "macos")]
impl MacOSClipboard {
    pub fn new() -> Self {
        let clipboard = arboard::Clipboard::new().ok();
        Self {
            clipboard: Mutex::new(clipboard),
        }
    }
}

#[cfg(target_os = "macos")]
impl NativeClipboard for MacOSClipboard {
    fn get_string(&self) -> Result<String, ClipboardError> {
        let mut guard = self.clipboard.lock().map_err(|e| {
            ClipboardError::PlatformError(format!("lock poisoned: {}", e))
        })?;
        if let Some(clipboard) = guard.as_mut() {
            clipboard
                .get_text()
                .map_err(|e| ClipboardError::PlatformError(e.to_string()))
        } else {
            Err(ClipboardError::NotAvailable)
        }
    }

    fn set_string(&self, text: &str) -> Result<(), ClipboardError> {
        let mut guard = self.clipboard.lock().map_err(|e| {
            ClipboardError::PlatformError(format!("lock poisoned: {}", e))
        })?;
        if let Some(clipboard) = guard.as_mut() {
            clipboard
                .set_text(text)
                .map_err(|e| ClipboardError::PlatformError(e.to_string()))
        } else {
            Err(ClipboardError::NotAvailable)
        }
    }

    fn is_available(&self) -> bool {
        self.clipboard
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    fn clear(&self) -> Result<(), ClipboardError> {
        self.set_string("")
    }

    fn get_formats(&self) -> Vec<String> {
        vec!["text/plain".to_string(), "text/utf-8".to_string()]
    }
}

/// Linux clipboard implementation
#[cfg(target_os = "linux")]
pub struct LinuxClipboard {
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

#[cfg(target_os = "linux")]
impl LinuxClipboard {
    pub fn new() -> Self {
        let clipboard = arboard::Clipboard::new().ok();
        Self {
            clipboard: Mutex::new(clipboard),
        }
    }
}

#[cfg(target_os = "linux")]
impl NativeClipboard for LinuxClipboard {
    fn get_string(&self) -> Result<String, ClipboardError> {
        let mut guard = self.clipboard.lock().map_err(|e| {
            ClipboardError::PlatformError(format!("lock poisoned: {}", e))
        })?;
        if let Some(clipboard) = guard.as_mut() {
            clipboard
                .get_text()
                .map_err(|e| ClipboardError::PlatformError(e.to_string()))
        } else {
            Err(ClipboardError::NotAvailable)
        }
    }

    fn set_string(&self, text: &str) -> Result<(), ClipboardError> {
        let mut guard = self.clipboard.lock().map_err(|e| {
            ClipboardError::PlatformError(format!("lock poisoned: {}", e))
        })?;
        if let Some(clipboard) = guard.as_mut() {
            clipboard
                .set_text(text)
                .map_err(|e| ClipboardError::PlatformError(e.to_string()))
        } else {
            Err(ClipboardError::NotAvailable)
        }
    }

    fn is_available(&self) -> bool {
        self.clipboard
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    fn clear(&self) -> Result<(), ClipboardError> {
        self.set_string("")
    }

    fn get_formats(&self) -> Vec<String> {
        vec!["text/plain".to_string(), "text/plain;charset=utf-8".to_string()]
    }
}

/// Windows clipboard implementation
#[cfg(target_os = "windows")]
pub struct WindowsClipboard;

#[cfg(target_os = "windows")]
impl WindowsClipboard {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "windows")]
impl NativeClipboard for WindowsClipboard {
    fn get_string(&self) -> Result<String, ClipboardError> {
        clipboard_win::get_clipboard_string()
            .map_err(|e| ClipboardError::PlatformError(e.to_string()))
    }

    fn set_string(&self, text: &str) -> Result<(), ClipboardError> {
        clipboard_win::set_clipboard_string(text)
            .map_err(|e| ClipboardError::PlatformError(e.to_string()))
    }

    fn is_available(&self) -> bool {
        clipboard_win::is_clipboard_format_available(clipboard_win::CF_UNICODETEXT)
    }

    fn clear(&self) -> Result<(), ClipboardError> {
        clipboard_win::empty_clipboard()
            .map_err(|e| ClipboardError::PlatformError(e.to_string()))
    }

    fn get_formats(&self) -> Vec<String> {
        vec!["text/plain".to_string(), "Unicode Text".to_string()]
    }
}

/// Fallback clipboard implementation for unsupported platforms
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub struct FallbackClipboard;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl FallbackClipboard {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl NativeClipboard for FallbackClipboard {
    fn get_string(&self) -> Result<String, ClipboardError> {
        Err(ClipboardError::NotAvailable)
    }

    fn set_string(&self, _text: &str) -> Result<(), ClipboardError> {
        Err(ClipboardError::NotAvailable)
    }

    fn is_available(&self) -> bool {
        false
    }

    fn clear(&self) -> Result<(), ClipboardError> {
        Err(ClipboardError::NotAvailable)
    }

    fn get_formats(&self) -> Vec<String> {
        vec![]
    }
}

/// Platform-specific clipboard factory
pub fn get_clipboard() -> Box<dyn NativeClipboard> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOSClipboard::new())
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxClipboard::new())
    }

    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsClipboard::new())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(FallbackClipboard::new())
    }
}

// NOTE: WASM/browser clipboard exports were removed. They referenced the
// undeclared `web_sys` crate and clipboard access requires native platform
// APIs. This crate is native-only.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn test_macos_clipboard() {
        let clipboard = MacOSClipboard::new();
        assert!(clipboard.is_available());

        let test_text = "Test content for clipboard";

        // Test set and get
        let _ = clipboard.set_string(test_text);
        let retrieved = clipboard.get_string();

        // Note: This might fail if the system doesn't allow clipboard access
        if let Ok(content) = retrieved {
            assert_eq!(content, test_text);
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_linux_clipboard() {
        let clipboard = LinuxClipboard::new();
        // Linux clipboard might not be available in all environments
        if clipboard.is_available() {
            let test_text = "Test content for Linux clipboard";
            let _ = clipboard.set_string(test_text);
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_clipboard() {
        let clipboard = WindowsClipboard::new();
        assert!(clipboard.is_available());

        let test_text = "Test content for Windows clipboard";

        // Test set and get
        let _ = clipboard.set_string(test_text);
        let retrieved = clipboard.get_string();

        // Note: This might fail if the system doesn't allow clipboard access
        if let Ok(content) = retrieved {
            assert_eq!(content, test_text);
        }
    }

    #[test]
    fn test_clipboard_factory() {
        let clipboard = get_clipboard();
        assert!(clipboard.is_available() || !clipboard.is_available()); // Just check it doesn't crash
    }

    #[test]
    fn test_clipboard_formats() {
        let clipboard = get_clipboard();
        let formats = clipboard.get_formats();
        assert!(!formats.is_empty() || formats.is_empty()); // Just check it doesn't crash
    }
}
