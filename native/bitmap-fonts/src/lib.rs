//! Bitmap font rendering for terminal UI
//! Supports BDF (Bitmap Distribution Format) and unscii-8.hex formats

use std::collections::HashMap;
use std::fmt;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum FontError {
    #[error("Invalid font format")]
    InvalidFormat,
    #[error("Missing glyph: {0}")]
    MissingGlyph(char),
    #[error("Parse error: {0}")]
    ParseError(String),
}

#[derive(Clone, Debug)]
pub struct FontMetrics {
    pub height: u8,
    pub width: u8,
    pub baseline: i8,
}

#[derive(Clone, Debug)]
pub struct GlyphBitmap {
    pub width: u8,
    pub height: u8,
    pub data: Vec<u8>, // 1-bit per pixel, row-major order
}

#[derive(Clone)]
pub struct BitmapFont {
    glyphs: HashMap<char, GlyphBitmap>,
    metrics: FontMetrics,
}

impl BitmapFont {
    /// Create a new empty font with specified metrics
    pub fn new(metrics: FontMetrics) -> Self {
        Self {
            glyphs: HashMap::new(),
            metrics,
        }
    }

    /// Load BDF (Bitmap Distribution Format) font
    pub fn load_bdf(data: &str) -> Result<Self, FontError> {
        let mut metrics = FontMetrics {
            height: 8,
            width: 5,
            baseline: 0,
        };

        let mut glyphs = HashMap::new();
        let mut current_char: Option<char> = None;
        let mut bitmap_data = Vec::new();
        let mut glyph_width = 0u8;
        let mut glyph_height = 0u8;
        let mut in_bitmap = false;

        for line in data.lines() {
            if line.trim().is_empty() {
                continue;
            }

            if line.starts_with("FONTBOUNDINGBOX") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    if let (Ok(w), Ok(h)) = (
                        parts[1].parse::<u8>(),
                        parts[2].parse::<u8>(),
                    ) {
                        metrics.width = w;
                        metrics.height = h;
                    }
                }
                continue;
            }

            if line.starts_with("ENCODING") {
                if let Some(char_code) = line.split_whitespace().nth(1) {
                    if let Ok(code) = char_code.parse::<u32>() {
                        if let Some(c) = char::from_u32(code) {
                            current_char = Some(c);
                        }
                    }
                }
                continue;
            }

            if line.starts_with("BBX") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    if let (Ok(w), Ok(h)) = (
                        parts[1].parse::<u8>(),
                        parts[2].parse::<u8>(),
                    ) {
                        glyph_width = w;
                        glyph_height = h;
                    }
                }
                continue;
            }

            if line == "BITMAP" {
                in_bitmap = true;
                bitmap_data.clear();
                continue;
            }

            if line == "ENDCHAR" {
                if let Some(c) = current_char {
                    glyphs.insert(
                        c,
                        GlyphBitmap {
                            width: glyph_width,
                            height: glyph_height,
                            data: bitmap_data.clone(),
                        },
                    );
                }
                in_bitmap = false;
                current_char = None;
                bitmap_data.clear();
                continue;
            }

            if in_bitmap {
                // Parse hex bitmap data
                let hex_str = line.trim();
                if let Ok(byte_value) = u8::from_str_radix(hex_str, 16) {
                    bitmap_data.push(byte_value);
                }
            }
        }

        Ok(Self { glyphs, metrics })
    }

    /// Load unscii-8.hex format (8x8 hexadecimal font)
    pub fn load_unscii_hex(data: &str) -> Result<Self, FontError> {
        let metrics = FontMetrics {
            height: 8,
            width: 8,
            baseline: 0,
        };

        let mut glyphs = HashMap::new();
        let mut current_char = 0x20u32; // Start with space

        for line in data.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("#") {
                continue;
            }

            // Parse 8 bytes per character (8x8 bitmap)
            let bytes: Vec<u8> = line
                .split_whitespace()
                .filter_map(|hex| u8::from_str_radix(hex, 16).ok())
                .collect();

            if bytes.len() == 8 {
                if let Some(c) = char::from_u32(current_char) {
                    glyphs.insert(
                        c,
                        GlyphBitmap {
                            width: 8,
                            height: 8,
                            data: bytes,
                        },
                    );
                }
                current_char += 1;

                // Stop at 126 (~)
                if current_char > 126 {
                    break;
                }
            }
        }

        Ok(Self { glyphs, metrics })
    }

    /// Add a glyph to the font
    pub fn add_glyph(&mut self, ch: char, glyph: GlyphBitmap) {
        self.glyphs.insert(ch, glyph);
    }

    /// Get a glyph for a character
    pub fn get_glyph(&self, ch: char) -> Option<&GlyphBitmap> {
        self.glyphs.get(&ch)
    }

    /// Get font metrics
    pub fn metrics(&self) -> &FontMetrics {
        &self.metrics
    }

    /// Measure text width in pixels
    pub fn measure_text(&self, text: &str) -> usize {
        text.chars()
            .map(|c| {
                self.get_glyph(c)
                    .map(|g| g.width as usize)
                    .unwrap_or(self.metrics.width as usize)
            })
            .sum()
    }

    /// Render text to ANSI terminal output
    pub fn render_text(&self, text: &str) -> String {
        let mut result = String::new();
        let height = self.metrics.height as usize;

        // Render text line by line (top to bottom)
        for y in 0..height {
            for ch in text.chars() {
                if let Some(glyph) = self.get_glyph(ch) {
                    let glyph_height = glyph.height as usize;
                    if y < glyph_height {
                        let byte_index = y;
                        if byte_index < glyph.data.len() {
                            let row_data = glyph.data[byte_index];
                            self.render_row(&mut result, row_data, glyph.width);
                        } else {
                            self.render_space(&mut result, glyph.width);
                        }
                    } else {
                        self.render_space(&mut result, glyph.width);
                    }
                } else {
                    self.render_space(&mut result, self.metrics.width);
                }
            }
            result.push('\n');
        }

        result
    }

    /// Render a single row of pixels
    fn render_row(&self, output: &mut String, row_data: u8, width: u8) {
        for x in 0..width {
            let mask = 1 << (width - 1 - x);
            if row_data & mask != 0 {
                output.push('█'); // Full block
            } else {
                output.push(' '); // Space
            }
        }
    }

    /// Render empty space
    fn render_space(&self, output: &mut String, width: u8) {
        for _ in 0..width {
            output.push(' ');
        }
    }

    /// Create default 5x8 font (basic ASCII)
    pub fn default_5x8() -> Self {
        let mut font = Self::new(FontMetrics {
            height: 8,
            width: 5,
            baseline: 0,
        });

        // Add basic ASCII glyphs (simplified version)
        // In a full implementation, these would be loaded from a BDF file
        font.add_default_ascii();
        font
    }

    fn add_default_ascii(&mut self) {
        // Add space
        self.glyphs.insert(
            ' ',
            GlyphBitmap {
                width: 5,
                height: 8,
                data: vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
            },
        );

        // Add uppercase 'A'
        self.glyphs.insert(
            'A',
            GlyphBitmap {
                width: 5,
                height: 8,
                data: vec![0x3C, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00],
            },
        );

        // Add lowercase 'a'
        self.glyphs.insert(
            'a',
            GlyphBitmap {
                width: 5,
                height: 8,
                data: vec![0x00, 0x00, 0x3C, 0x06, 0x3E, 0x66, 0x3E, 0x00],
            },
        );
    }
}

impl fmt::Debug for BitmapFont {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitmapFont")
            .field("metrics", &self.metrics)
            .field("glyph_count", &self.glyphs.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_font() {
        let font = BitmapFont::default_5x8();
        assert_eq!(font.glyphs.len(), 3); // Space, A, a
        assert_eq!(font.metrics.height, 8);
        assert_eq!(font.metrics.width, 5);
    }

    #[test]
    fn test_measure_text() {
        let font = BitmapFont::default_5x8();
        let width = font.measure_text("AAA");
        assert_eq!(width, 15); // 3 * 5
    }

    #[test]
    fn test_render_text() {
        let font = BitmapFont::default_5x8();
        let rendered = font.render_text("A");
        assert!(rendered.contains("█"));
    }
}

// WASM exports
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmBitmapFont {
    inner: BitmapFont,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmBitmapFont {
    #[wasm_bindgen(constructor)]
    pub fn new_default() -> Self {
        Self {
            inner: BitmapFont::default_5x8(),
        }
    }

    #[wasm_bindgen]
    pub fn load_bdf(data: &str) -> Result<WasmBitmapFont, JsValue> {
        BitmapFont::load_bdf(data)
            .map(|inner| WasmBitmapFont { inner })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn load_unscii_hex(data: &str) -> Result<WasmBitmapFont, JsValue> {
        BitmapFont::load_unscii_hex(data)
            .map(|inner| WasmBitmapFont { inner })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn render_text(&self, text: &str) -> String {
        self.inner.render_text(text)
    }

    #[wasm_bindgen]
    pub fn measure_text(&self, text: &str) -> usize {
        self.inner.measure_text(text)
    }

    #[wasm_bindgen]
    pub fn height(&self) -> u8 {
        self.inner.metrics.height
    }

    #[wasm_bindgen]
    pub fn width(&self) -> u8 {
        self.inner.metrics.width
    }
}
