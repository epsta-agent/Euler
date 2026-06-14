/**
 * Performance benchmarking for native vs TypeScript implementations
 * Validates the 2-5x performance improvements from Rust/WASM modules
 */

import { initNative, nativeFont, nativeSearch, benchmarks } from './bridge';

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  iterations: 1000,
  sampleText: 'Hello, World! This is a test of the native bitmap font rendering system.',
  searchPattern: 'function',
  testPath: './src',
};

/**
 * Run comprehensive performance benchmarks
 */
async function runBenchmarks(): Promise<void> {
  console.log('🚀 Euler Agent Native Performance Benchmarking\n');
  console.log('=' .repeat(60));

  // Initialize native modules
  console.log('📦 Initializing native WASM modules...');
  await initNative();
  console.log('✅ Native modules initialized\n');

  // Font rendering benchmark
  console.log('📊 Font Rendering Benchmark');
  console.log('-'.repeat(60));
  try {
    const fontResults = await benchmarks.benchmarkFontRendering(
      BENCHMARK_CONFIG.sampleText,
      BENCHMARK_CONFIG.iterations
    );

    console.log(`  Native (Rust/WASM): ${fontResults.native.toFixed(2)}ms`);
    console.log(`  TypeScript: ${fontResults.typescript.toFixed(2)}ms`);
    console.log(`  ⚡ Speedup: ${fontResults.speedup.toFixed(2)}x`);

    if (fontResults.speedup >= 2.0) {
      console.log('  ✅ Meets target (≥2x speedup)');
    } else if (fontResults.speedup >= 1.5) {
      console.log('  ⚠️ Partial improvement (1.5-2x speedup)');
    } else {
      console.log('  ❌ Below target (<1.5x speedup)');
    }
  } catch (error) {
    console.error('  ❌ Font benchmark failed:', error);
  }
  console.log();

  // Search performance benchmark
  console.log('📊 Search Performance Benchmark (ripgrep-style)');
  console.log('-'.repeat(60));
  try {
    const searchResults = await benchmarks.benchmarkSearch(
      BENCHMARK_CONFIG.searchPattern,
      BENCHMARK_CONFIG.testPath,
      BENCHMARK_CONFIG.iterations
    );

    console.log(`  Native (Rust/WASM): ${searchResults.native.toFixed(2)}ms`);
    console.log(`  TypeScript: ${searchResults.typescript.toFixed(2)}ms`);
    console.log(`  ⚡ Speedup: ${searchResults.speedup.toFixed(2)}x`);

    if (searchResults.speedup >= 4.0) {
      console.log('  ✅ Exceeds target (≥4x speedup - ripgrep level)');
    } else if (searchResults.speedup >= 2.0) {
      console.log('  ✅ Meets target (≥2x speedup)');
    } else {
      console.log('  ❌ Below target (<2x speedup)');
    }
  } catch (error) {
    console.error('  ❌ Search benchmark failed:', error);
  }
  console.log();

  // Summary
  console.log('=' .repeat(60));
  console.log('📈 Performance Summary');
  console.log('=' .repeat(60));
  console.log('Target: 2-5x performance improvement over TypeScript');
  console.log('Status: Native modules integrated and benchmarked');
  console.log();
  console.log('Next Steps:');
  console.log('1. Deploy native modules to production');
  console.log('2. Monitor real-world performance metrics');
  console.log('3. Optimize hot paths based on usage patterns');
  console.log('4. Add additional native modules as needed');
}

/**
 * Demo font rendering
 */
async function demoFontRendering(): Promise<void> {
  console.log('🎨 Native Font Rendering Demo\n');

  await initNative();

  const font = await nativeFont.createDefault();
  if (!font) {
    console.log('❌ Native font not available');
    return;
  }

  const sampleTexts = [
    'Hello, World!',
    'Euler Agent',
    'Native Performance',
    'Bitmap Fonts',
  ];

  for (const text of sampleTexts) {
    console.log(`\n📝 "${text}"`);
    console.log('-'.repeat(40));
    const rendered = font.renderText(text);
    console.log(rendered);
    console.log(`Width: ${font.measureText(text)}px`);
  }

  console.log('\n✅ Font rendering demo complete\n');
}

/**
 * Demo search functionality
 */
async function demoSearch(): Promise<void> {
  console.log('🔍 Native Search Demo (ripgrep-style)\n');

  await initNative();

  const searcher = nativeSearch.createSearcher();
  if (!searcher) {
    console.log('❌ Native search not available');
    return;
  }

  console.log('🔧 Searching for "export" in ./src directory...\n');

  try {
    const results = await searcher.searchFile('export', './src/native/bridge.ts', false);

    console.log(`Found ${results.length} matches:\n`);
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const match = results[i];
      console.log(`  ${match.path}:${match.line_number}`);
      console.log(`    ${match.line.trim()}`);
    }

    if (results.length > 5) {
      console.log(`  ... and ${results.length - 5} more matches`);
    }

    console.log(`\n✅ Search demo complete (${results.length} matches found)\n`);
  } catch (error) {
    console.error('❌ Search demo failed:', error);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'run':
      await runBenchmarks();
      break;
    case 'font':
      await demoFontRendering();
      break;
    case 'search':
      await demoSearch();
      break;
    default:
      console.log('Usage: bun benchmark [run|font|search]');
      console.log('  run     - Run all performance benchmarks');
      console.log('  font    - Demo native font rendering');
      console.log('  search  - Demo native search functionality');
      break;
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { runBenchmarks, demoFontRendering, demoSearch };
