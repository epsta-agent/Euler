/**
 * Grep command - Following oh-my-pi CLI architecture
 * Fast file search using ripgrep-like patterns
 */

export default {
  name: 'grep',
  description: 'Fast file search',
  handler: async (args: string[]) => {
    const pattern = args?.[0];
    const path = args?.[1] || '.';

    if (!pattern) {
      return `Usage: euler grep <pattern> [path]

Options:
  -i, --ignore-case  Case insensitive search
  -w, --word-regexp  Match whole words only
  -n, --line-number  Show line numbers
  -C, --context NUM  Show NUM lines of context

Examples:
  euler grep "function.*hello" src/
  euler grep -i "error" --line-number`;
    }

    // For now, use a simple recursive grep implementation
    const { readdirSync, statSync, readFileSync } = await import('fs');
    const { join, relative } = await import('path');

    const results: string[] = [];
    const ignoreCase = args?.includes('-i') || args?.includes('--ignore-case');
    const showLineNumbers = args?.includes('-n') || args?.includes('--line-number');
    const wordOnly = args?.includes('-w') || args?.includes('--word-regexp');

    // Build regex pattern
    let regexPattern = pattern;
    if (wordOnly) {
      regexPattern = `\\b${regexPattern}\\b`;
    }
    const flags = ignoreCase ? 'gi' : 'g';
    const regex = new RegExp(regexPattern, flags);

    function searchDirectory(dir: string, basePath = dir) {
      try {
        const entries = readdirSync(dir);

        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);

          if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
            searchDirectory(fullPath, basePath);
          } else if (stat.isFile()) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (regex.test(line)) {
                  const relPath = relative(basePath, fullPath);
                  const prefix = showLineNumbers ? `${relPath}:${i + 1}:` : `${relPath}:`;
                  results.push(`${prefix}${line.trim()}`);
                }
              }
            } catch {
              // Skip files that can't be read
            }
          }
        }
      } catch {
        // Skip directories that can't be read
      }
    }

    searchDirectory(path);

    if (results.length === 0) {
      return `No matches found for "${pattern}"`;
    }

    return `Found ${results.length} matches:\n\n${results.join('\n')}`;
  }
};
