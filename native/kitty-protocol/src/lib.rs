//! Kitty keyboard protocol support for enhanced keyboard input
//! Provides advanced keyboard features in terminals that support the Kitty protocol

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum KittyError {
    #[error("Invalid Kitty protocol sequence")]
    InvalidSequence,
    #[error("Kitty protocol not supported")]
    NotSupported,
    #[error("Parse error: {0}")]
    ParseError(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyEvent {
    /// Regular key press
    Key {
        key: String,
        shift: bool,
        alt: bool,
        ctrl: bool,
        super_: bool,
        meta: bool,
    },
    /// Function key
    Function {
        number: u8,
        shift: bool,
        alt: bool,
        ctrl: bool,
    },
    /// Special key (Enter, Tab, Backspace, etc.)
    Special {
        key: SpecialKey,
        shift: bool,
        alt: bool,
        ctrl: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpecialKey {
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Delete,
    Insert,
}

#[derive(Clone, Debug)]
pub struct KittyProtocol {
    enabled: bool,
    supported: bool,
    disambiguate_escape_codes: bool,
    report_event_types: bool,
}

impl KittyProtocol {
    pub fn new() -> Self {
        Self {
            enabled: false,
            supported: false,
            disambiguate_escape_codes: true,
            report_event_types: true,
        }
    }

    /// Enable Kitty keyboard protocol
    pub fn enable(&mut self) -> String {
        self.enabled = true;
        // ANSI escape sequence to enable Kitty keyboard protocol
        "\x1b[>1u".to_string()
    }

    /// Disable Kitty keyboard protocol
    pub fn disable(&mut self) -> String {
        self.enabled = false;
        // ANSI escape sequence to disable Kitty keyboard protocol
        "\x1b[<u".to_string()
    }

    /// Enable with specific options
    pub fn enable_with_options(&mut self, disambiguate: bool, report_events: bool) -> String {
        self.disambiguate_escape_codes = disambiguate;
        self.report_event_types = report_events;

        let flags = if disambiguate { 1 } else { 0 } | if report_events { 2 } else { 0 };
        self.enabled = true;

        format!("\x1b[>{}u", flags)
    }

    /// Check if Kitty protocol is supported
    pub fn check_support(&self) -> String {
        // Query terminal for Kitty protocol support
        "\x1b[>c".to_string()
    }

    /// Parse Kitty protocol keyboard event
    pub fn parse_event(&self, input: &str) -> Result<KeyEvent, KittyError> {
        // Kitty keyboard events start with CSI and end with 'u'
        // Format: CSI [modifiers] KEY u
        // Example: ESC [ 1 ; 3 97 u (Ctrl+Shift+Alt+a)

        if !input.starts_with("\x1b[") || !input.ends_with('u') {
            return Err(KittyError::InvalidSequence);
        }

        // Remove CSI prefix and 'u' suffix
        let inner = &input[2..input.len() - 1];
        let parts: Vec<&str> = inner.split(';').collect();

        if parts.is_empty() {
            return Err(KittyError::InvalidSequence);
        }

        // Parse the main key/value
        let key_value: u32 = parts[0].parse().unwrap_or(0);
        let modifiers = if parts.len() > 1 {
            self.parse_modifiers(parts[1])
        } else {
            ModifierFlags::default()
        };

        self.parse_key_event(key_value, modifiers)
    }

    /// Parse Kitty protocol push buttons
    pub fn parse_push_button(&self, input: &str) -> Result<PushButton, KittyError> {
        // Kitty push button events: CSI button_id ; button_start ; button_end ; action_id u
        if !input.starts_with("\x1b[") || !input.ends_with('u') {
            return Err(KittyError::InvalidSequence);
        }

        let inner = &input[2..input.len() - 1];
        let parts: Vec<&str> = inner.split(';').collect();

        if parts.len() < 4 {
            return Err(KittyError::InvalidSequence);
        }

        Ok(PushButton {
            button_id: parts[0].parse().unwrap_or(0),
            button_start: parts[1].parse().unwrap_or(0),
            button_end: parts[2].parse().unwrap_or(0),
            action_id: parts[3].parse().unwrap_or(0),
        })
    }

    /// Create key event string for terminal
    pub fn create_key_event(&self, event: &KeyEvent) -> String {
        match event {
            KeyEvent::Key { key, shift, alt, ctrl, super_: _, meta: _ } => {
                let modifiers = self.modifiers_to_flags(*shift, *alt, *ctrl, false);
                let key_code = self.key_to_code(key);
                format!("\x1b[{};{}u", key_code, modifiers)
            }
            KeyEvent::Function { number, shift, alt, ctrl } => {
                let modifiers = self.modifiers_to_flags(*shift, *alt, *ctrl, false);
                let key_code = 57 + number; // Function keys start at 57 in Kitty protocol
                format!("\x1b[{};{}u", key_code, modifiers)
            }
            KeyEvent::Special { key, shift, alt, ctrl } => {
                let modifiers = self.modifiers_to_flags(*shift, *alt, *ctrl, false);
                let key_code = self.special_key_to_code(key);
                format!("\x1b[{};{}u", key_code, modifiers)
            }
        }
    }

    // Helper functions
    fn parse_modifiers(&self, modifier_str: &str) -> ModifierFlags {
        let modifier_val = modifier_str.parse().unwrap_or(0);
        ModifierFlags {
            shift: (modifier_val & 1) != 0,
            alt: (modifier_val & 2) != 0,
            ctrl: (modifier_val & 4) != 0,
            super_: (modifier_val & 8) != 0,
            meta: (modifier_val & 16) != 0,
        }
    }

    fn parse_key_event(&self, key_value: u32, modifiers: ModifierFlags) -> Result<KeyEvent, KittyError> {
        let key_code = key_value;

        // Function keys (57-66 for F1-F12)
        if (57..=66).contains(&key_code) {
            return Ok(KeyEvent::Function {
                number: (key_code - 56) as u8,
                shift: modifiers.shift,
                alt: modifiers.alt,
                ctrl: modifiers.ctrl,
            });
        }

        // Special keys
        if let Some(special_key) = self.code_to_special_key(key_code) {
            return Ok(KeyEvent::Special {
                key: special_key,
                shift: modifiers.shift,
                alt: modifiers.alt,
                ctrl: modifiers.ctrl,
            });
        }

        // Regular keys (ASCII values)
        if key_code >= 32 && key_code <= 126 {
            return Ok(KeyEvent::Key {
                key: ((key_code as u8) as char).to_string(),
                shift: modifiers.shift,
                alt: modifiers.alt,
                ctrl: modifiers.ctrl,
                super_: modifiers.super_,
                meta: modifiers.meta,
            });
        }

        Err(KittyError::InvalidSequence)
    }

    fn key_to_code(&self, key: &str) -> u32 {
        key.chars()
            .next()
            .map(|c| c as u32)
            .unwrap_or(0)
    }

    fn special_key_to_code(&self, key: &SpecialKey) -> u32 {
        match key {
            SpecialKey::Enter => 13,
            SpecialKey::Tab => 9,
            SpecialKey::Backspace => 2,
            SpecialKey::Escape => 27,
            SpecialKey::Up => 16777232,
            SpecialKey::Down => 16777233,
            SpecialKey::Left => 16777234,
            SpecialKey::Right => 16777235,
            SpecialKey::Home => 16777230,
            SpecialKey::End => 16777231,
            SpecialKey::PageUp => 16777228,
            SpecialKey::PageDown => 16777229,
            SpecialKey::Delete => 16777226,
            SpecialKey::Insert => 16777225,
        }
    }

    fn code_to_special_key(&self, code: u32) -> Option<SpecialKey> {
        match code {
            13 => Some(SpecialKey::Enter),
            9 => Some(SpecialKey::Tab),
            2 => Some(SpecialKey::Backspace),
            27 => Some(SpecialKey::Escape),
            16777232 => Some(SpecialKey::Up),
            16777233 => Some(SpecialKey::Down),
            16777234 => Some(SpecialKey::Left),
            16777235 => Some(SpecialKey::Right),
            16777230 => Some(SpecialKey::Home),
            16777231 => Some(SpecialKey::End),
            16777228 => Some(SpecialKey::PageUp),
            16777229 => Some(SpecialKey::PageDown),
            16777226 => Some(SpecialKey::Delete),
            16777225 => Some(SpecialKey::Insert),
            _ => None,
        }
    }

    fn modifiers_to_flags(&self, shift: bool, alt: bool, ctrl: bool, super_: bool) -> u32 {
        let mut flags = 0;
        if shift { flags |= 1; }
        if alt { flags |= 2; }
        if ctrl { flags |= 4; }
        if super_ { flags |= 8; }
        flags
    }
}

impl Default for KittyProtocol {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Default)]
struct ModifierFlags {
    shift: bool,
    alt: bool,
    ctrl: bool,
    super_: bool,
    meta: bool,
}

#[derive(Clone, Debug)]
pub struct PushButton {
    pub button_id: u32,
    pub button_start: u32,
    pub button_end: u32,
    pub action_id: u32,
}

// WASM exports
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmKittyProtocol {
    inner: KittyProtocol,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmKittyProtocol {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: KittyProtocol::new(),
        }
    }

    #[wasm_bindgen]
    pub fn enable(&mut self) -> String {
        self.inner.enable()
    }

    #[wasm_bindgen]
    pub fn disable(&mut self) -> String {
        self.inner.disable()
    }

    #[wasm_bindgen]
    pub fn enable_with_options(&mut self, disambiguate: bool, report_events: bool) -> String {
        self.inner.enable_with_options(disambiguate, report_events)
    }

    #[wasm_bindgen]
    pub fn check_support(&self) -> String {
        self.inner.check_support()
    }

    #[wasm_bindgen]
    pub fn parse_event(&self, input: &str) -> Result<JsValue, JsValue> {
        self.inner
            .parse_event(input)
            .map(|event| {
                serde_wasm_bindgen::to_value(&event).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn create_key_event(&self, event_js: JsValue) -> Result<String, JsValue> {
        let event: KeyEvent = serde_wasm_bindgen::from_value(event_js)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        Ok(self.inner.create_key_event(&event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kitty_protocol_enable() {
        let mut protocol = KittyProtocol::new();
        let enable_seq = protocol.enable();
        assert_eq!(enable_seq, "\x1b[>1u");
    }

    #[test]
    fn test_kitty_protocol_disable() {
        let mut protocol = KittyProtocol::new();
        let disable_seq = protocol.disable();
        assert_eq!(disable_seq, "\x1b[<u");
    }

    #[test]
    fn test_parse_key_event() {
        let protocol = KittyProtocol::new();
        // Test parsing a simple key event (ESC [ 97 u = 'a')
        let result = protocol.parse_event("\x1b[97u");
        assert!(result.is_ok());

        if let Ok(KeyEvent::Key { key, .. }) = result {
            assert_eq!(key, "a");
        } else {
            panic!("Expected KeyEvent::Key");
        }
    }

    #[test]
    fn test_create_key_event() {
        let protocol = KittyProtocol::new();
        let event = KeyEvent::Key {
            key: "a".to_string(),
            shift: false,
            alt: false,
            ctrl: false,
            super_: false,
            meta: false,
        };

        let event_str = protocol.create_key_event(&event);
        assert!(event_str.starts_with("\x1b["));
        assert!(event_str.ends_with('u'));
    }

    #[test]
    fn test_function_key() {
        let protocol = KittyProtocol::new();
        let event = KeyEvent::Function {
            number: 1,
            shift: false,
            alt: false,
            ctrl: false,
        };

        let event_str = protocol.create_key_event(&event);
        // F1 should be code 58 (57 + 1)
        assert!(event_str.contains("58"));
    }
}
