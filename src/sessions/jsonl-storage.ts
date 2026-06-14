/**
 * JSONL-based session storage
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { SessionStorage, SessionMetadata, Entry } from './types.ts';

export class JsonlStorage implements SessionStorage {
  private filePath: string;
  private metadata: SessionMetadata | null = null;
  private leafId: string | null = null;
  private entries: Entry[] = [];

  constructor(sessionPath: string) {
    this.filePath = sessionPath;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        if (!line) continue;
        const entry = JSON.parse(line) as Entry;

        if (line.startsWith('{"type":"meta"')) {
          this.metadata = JSON.parse(line) as SessionMetadata;
        } else {
          this.entries.push(entry);
          this.leafId = entry.id;
        }
      }
    } catch (error) {
      // File doesn't exist or is empty
      this.metadata = null;
      this.entries = [];
      this.leafId = null;
    }
  }

  async getMetadata(): Promise<SessionMetadata> {
    if (!this.metadata) {
      throw new Error('Session not loaded');
    }
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    return this.leafId;
  }

  async setLeafId(id: string | null): Promise<void> {
    this.leafId = id;
  }

  async getEntries(): Promise<Entry[]> {
    return [...this.entries];
  }

  async appendEntry(entry: Entry): Promise<void> {
    this.entries.push(entry);
    this.leafId = entry.id;
    await this.flush();
  }

  async createEntryId(): Promise<string> {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async setMetadata(metadata: SessionMetadata): Promise<void> {
    this.metadata = metadata;
    await this.flush();
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const lines: string[] = [];

    if (this.metadata) {
      lines.push(JSON.stringify(this.metadata));
    }

    for (const entry of this.entries) {
      lines.push(JSON.stringify(entry));
    }

    await writeFile(this.filePath, lines.join('\n') + '\n', 'utf-8');
  }
}
