/**
 * Utility functions
 */

export function formatPath(path: string): string {
  return path.replace(/^\/Users\/[^\/]+/, '~');
}

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
