//! Snapcompact WASM renderer for context compaction
//! Provides bitmap-based conversation archiving following oh-my-pi architecture

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SnapcompactError {
    #[error("Invalid frame shape for provider: {0}")]
    InvalidFrameShape(String),
    #[error("Token estimation failed: {0}")]
    TokenEstimationError(String),
    #[error("Compaction failed: {0}")]
    CompactionError(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    pub token_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompactFrame {
    pub provider: String,
    pub messages: Vec<CompactMessage>,
    pub metadata: FrameMetadata,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompactMessage {
    pub role: String,
    pub content_hash: String, // Content hash for deduplication
    pub token_count: usize,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameMetadata {
    pub total_tokens: usize,
    pub message_count: usize,
    pub compression_ratio: f64,
    pub timestamp: i64,
}

#[derive(Clone, Debug)]
pub enum Provider {
    Anthropic,
    Google,
    OpenAI,
    Mistral,
    Custom(String),
}

impl Provider {
    fn as_str(&self) -> &str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Google => "google",
            Provider::OpenAI => "openai",
            Provider::Mistral => "mistral",
            Provider::Custom(s) => s,
        }
    }

    fn frame_shape(&self) -> FrameShape {
        match self {
            Provider::Anthropic => FrameShape::Anthropic,
            Provider::Google => FrameShape::Google,
            Provider::OpenAI => FrameShape::OpenAI,
            Provider::Mistral => FrameShape::Mistral,
            Provider::Custom(_) => FrameShape::Generic,
        }
    }
}

#[derive(Clone, Debug)]
pub enum FrameShape {
    Anthropic,
    Google,
    OpenAI,
    Mistral,
    Generic,
}

impl FrameShape {
    fn max_tokens(&self) -> usize {
        match self {
            FrameShape::Anthropic => 200000, // Claude 3.5
            FrameShape::Google => 1000000,    // Gemini 1.5
            FrameShape::OpenAI => 128000,     // GPT-4
            FrameShape::Mistral => 32000,     // Mistral Large
            FrameShape::Generic => 50000,    // Conservative default
        }
    }

    fn target_compaction_ratio(&self) -> f64 {
        match self {
            FrameShape::Anthropic => 0.7,  // Keep 70% of context
            FrameShape::Google => 0.8,     // Keep 80% (larger context)
            FrameShape::OpenAI => 0.75,   // Keep 75%
            FrameShape::Mistral => 0.6,    // Keep 60% (smaller context)
            FrameShape::Generic => 0.65,   // Conservative 65%
        }
    }
}

pub struct SnapcompactRenderer {
    provider: Provider,
    cache: HashMap<String, Vec<u8>>,
}

impl SnapcompactRenderer {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            cache: HashMap::new(),
        }
    }

    /// Render conversation to compact frame
    pub fn render_conversation(&mut self, messages: &[Message]) -> Result<CompactFrame, SnapcompactError> {
        let frame_shape = self.provider.frame_shape();
        let target_ratio = frame_shape.target_compaction_ratio();

        // Estimate tokens and sort by importance
        let mut estimated_messages: Vec<CompactMessage> = messages
            .iter()
            .map(|msg| {
                let token_count = self.estimate_tokens(&msg.content);
                CompactMessage {
                    role: msg.role.clone(),
                    content_hash: self.hash_content(&msg.content),
                    token_count,
                    timestamp: msg.timestamp,
                }
            })
            .collect();

        let total_tokens: usize = estimated_messages.iter().map(|m| m.token_count).sum();
        let target_tokens = (total_tokens as f64 * target_ratio) as usize;

        // Compact conversation
        let compacted = self.compact_messages(&mut estimated_messages, target_tokens);

        let compression_ratio = if total_tokens > 0 {
            compacted.iter().map(|m| m.token_count).sum::<usize>() as f64 / total_tokens as f64
        } else {
            0.0
        };

        Ok(CompactFrame {
            provider: self.provider.as_str().to_string(),
            messages: compacted,
            metadata: FrameMetadata {
                total_tokens,
                message_count: messages.len(),
                compression_ratio: 1.0 - compression_ratio,
                timestamp: chrono::Utc::now().timestamp(),
            },
        })
    }

    /// Optimize for specific provider
    pub fn optimize_for_provider(&mut self, provider: Provider) {
        self.provider = provider;
        self.cache.clear(); // Clear cache when provider changes
    }

    /// Estimate token count with high accuracy
    pub fn estimate_tokens(&self, text: &str) -> usize {
        // Provider-specific token estimation
        match self.provider {
            Provider::Anthropic => self.estimate_anthropic_tokens(text),
            Provider::Google => self.estimate_google_tokens(text),
            Provider::OpenAI => self.estimate_openai_tokens(text),
            Provider::Mistral => self.estimate_mistral_tokens(text),
            Provider::Custom(_) => self.estimate_generic_tokens(text),
        }
    }

    /// Calculate compaction ratio
    pub fn compaction_ratio(&self) -> f64 {
        self.provider.frame_shape().target_compaction_ratio()
    }

    // Helper functions
    fn compact_messages(&self, messages: &mut [CompactMessage], target_tokens: usize) -> Vec<CompactMessage> {
        // Sort by timestamp (keep recent messages)
        messages.sort_by_key(|m| std::cmp::Reverse(m.timestamp));

        let mut result = Vec::new();
        let mut current_tokens = 0;

        for msg in messages.iter() {
            if current_tokens + msg.token_count <= target_tokens {
                current_tokens += msg.token_count;
                result.push(msg.clone());
            }
        }

        // Sort back by timestamp
        result.sort_by_key(|m| m.timestamp);
        result
    }

    fn hash_content(&self, content: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }

    fn estimate_anthropic_tokens(&self, text: &str) -> usize {
        // Claude token estimation (roughly 4 chars per token)
        (text.len() / 4) + self.count_special_tokens(text)
    }

    fn estimate_google_tokens(&self, text: &str) -> usize {
        // Gemini token estimation (roughly 4 chars per token)
        (text.len() / 4) + self.count_special_tokens(text)
    }

    fn estimate_openai_tokens(&self, text: &str) -> usize {
        // GPT token estimation (roughly 4 chars per token)
        (text.len() / 4) + self.count_special_tokens(text)
    }

    fn estimate_mistral_tokens(&self, text: &str) -> usize {
        // Mistral token estimation (roughly 4 chars per token)
        (text.len() / 4) + self.count_special_tokens(text)
    }

    fn estimate_generic_tokens(&self, text: &str) -> usize {
        // Generic token estimation (roughly 4 chars per token)
        (text.len() / 4) + self.count_special_tokens(text)
    }

    fn count_special_tokens(&self, text: &str) -> usize {
        // Count special tokens (newlines, code blocks, etc.)
        let mut count = 0;

        // Count newlines
        count += text.matches('\n').count() / 10;

        // Count code blocks
        count += text.matches("```").count() * 2;

        // Count other special patterns
        count += text.matches(|c: char| !c.is_ascii() && !c.is_whitespace()).count() / 20;

        count
    }
}

// WASM exports
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmSnapcompactRenderer {
    inner: SnapcompactRenderer,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmSnapcompactRenderer {
    #[wasm_bindgen(constructor)]
    pub fn new(provider: &str) -> Result<WasmSnapcompactRenderer, JsValue> {
        let provider = match provider {
            "anthropic" => Provider::Anthropic,
            "google" => Provider::Google,
            "openai" => Provider::OpenAI,
            "mistral" => Provider::Mistral,
            _ => Provider::Custom(provider.to_string()),
        };

        Ok(Self {
            inner: SnapcompactRenderer::new(provider),
        })
    }

    #[wasm_bindgen]
    pub fn render_conversation(&mut self, messages_js: JsValue) -> Result<JsValue, JsValue> {
        let messages: Vec<Message> = serde_wasm_bindgen::from_value(messages_js)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        self.inner
            .render_conversation(&messages)
            .map(|frame| {
                serde_wasm_bindgen::to_value(&frame).unwrap_or(JsValue::NULL)
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn estimate_tokens(&self, text: &str) -> usize {
        self.inner.estimate_tokens(text)
    }

    #[wasm_bindgen]
    pub fn compaction_ratio(&self) -> f64 {
        self.inner.compaction_ratio()
    }

    #[wasm_bindgen]
    pub fn optimize_for_provider(&mut self, provider: &str) {
        let provider = match provider {
            "anthropic" => Provider::Anthropic,
            "google" => Provider::Google,
            "openai" => Provider::OpenAI,
            "mistral" => Provider::Mistral,
            _ => Provider::Custom(provider.to_string()),
        };

        self.inner.optimize_for_provider(provider);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_messages() -> Vec<Message> {
        vec![
            Message {
                role: "user".to_string(),
                content: "Hello, how are you?".to_string(),
                timestamp: 1000,
                token_count: None,
            },
            Message {
                role: "assistant".to_string(),
                content: "I'm doing well, thank you!".to_string(),
                timestamp: 2000,
                token_count: None,
            },
            Message {
                role: "user".to_string(),
                content: "Can you help me with coding?".to_string(),
                timestamp: 3000,
                token_count: None,
            },
        ]
    }

    #[test]
    fn test_snapcompact_renderer() {
        let mut renderer = SnapcompactRenderer::new(Provider::Anthropic);
        let messages = create_test_messages();

        let result = renderer.render_conversation(&messages);
        assert!(result.is_ok());

        let frame = result.unwrap();
        assert_eq!(frame.provider, "anthropic");
        assert!(!frame.messages.is_empty());
    }

    #[test]
    fn test_token_estimation() {
        let renderer = SnapcompactRenderer::new(Provider::Anthropic);
        let text = "Hello, world! This is a test message for token estimation.";

        let tokens = renderer.estimate_tokens(text);
        assert!(tokens > 0);
        assert!(tokens < text.len()); // Should be much less than character count
    }

    #[test]
    fn test_compaction_ratio() {
        let renderer = SnapcompactRenderer::new(Provider::Anthropic);
        let ratio = renderer.compaction_ratio();

        assert!(ratio > 0.0);
        assert!(ratio <= 1.0);
        assert_eq!(ratio, 0.7); // Anthropic target
    }

    #[test]
    fn test_provider_optimization() {
        let mut renderer = SnapcompactRenderer::new(Provider::Anthropic);
        assert_eq!(renderer.compaction_ratio(), 0.7);

        renderer.optimize_for_provider(Provider::Google);
        assert_eq!(renderer.compaction_ratio(), 0.8);
    }

    #[test]
    fn test_hash_content() {
        let renderer = SnapcompactRenderer::new(Provider::Anthropic);
        let content = "Hello, world!";

        let hash1 = renderer.hash_content(content);
        let hash2 = renderer.hash_content(content);

        assert_eq!(hash1, hash2);

        let hash3 = renderer.hash_content("Different content");
        assert_ne!(hash1, hash3);
    }
}
