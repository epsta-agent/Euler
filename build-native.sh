#!/bin/bash
# Build script for Rust/WebAssembly native modules

set -e

echo "🔨 Building Euler Agent native modules..."

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack
fi

# Build WASM modules
echo "🔧 Building bitmap-fonts WASM module..."
cd native/bitmap-fonts
wasm-pack build --target bundler --out-dir ../../pkg/bitmap-fonts
cd ../..

echo "🔧 Building ripgrep-lite WASM module..."
cd native/ripgrep-lite
wasm-pack build --target bundler --out-dir ../../pkg/ripgrep-lite
cd ../..

echo "🔧 Building pty-bridge WASM module..."
cd native/pty-bridge
wasm-pack build --target bundler --out-dir ../../pkg/pty-bridge
cd ../..

# Build the native euler-debug binary (real DAP debugger).
echo "🔧 Building euler-debug native binary (debug profile)..."
cargo build --manifest-path native/Cargo.toml -p euler-debug --bin euler-debug

# Create unified WASM package
echo "🔗 Creating unified WASM package..."
mkdir -p pkg/euler_native_wasm

# Copy WASM modules to unified package
cp pkg/bitmap-fonts/bitmap_fonts_bg.wasm pkg/euler_native_wasm/ 2>/dev/null || true
cp pkg/ripgrep-lite/ripgrep_lite_bg.wasm pkg/euler_native_wasm/ 2>/dev/null || true
cp pkg/pty-bridge/pty_bridge_bg.wasm pkg/euler_native_wasm/ 2>/dev/null || true

# Copy JavaScript bindings
cp pkg/bitmap-fonts/bitmap_fonts.js pkg/euler_native_wasm/bitmap_fonts.js 2>/dev/null || true
cp pkg/ripgrep-lite/ripgrep_lite.js pkg/euler_native_wasm/ripgrep_lite.js 2>/dev/null || true
cp pkg/pty-bridge/pty_bridge.js pkg/euler_native_wasm/pty_bridge.js 2>/dev/null || true

# Create TypeScript declaration file
cat > pkg/euler_native_wasm/euler_native_wasm.d.ts << 'EOF'
// Auto-generated TypeScript declarations for WASM modules
export * from './bitmap_fonts';
export * from './ripgrep_lite';
export * from './pty_bridge';
EOF

echo "✅ Native modules built successfully!"
echo "📦 WASM output: pkg/euler_native_wasm/"
echo "🔧 Debugger binary: native/target/debug/euler-debug"
