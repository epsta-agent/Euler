/**
 * Session manager for Euler Agent - SQLite-based
 */

import { join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import type { SessionMetadata } from './types';
import { SQLiteSessionStorage, type SessionRecord } from './sqlite-storage';

export interface SessionInfo {
  id: string;
  metadata: SessionMetadata;
  messageCount: number;
  model: string;
  cwd: string;
}

export class SessionManager {
  private storage: SQLiteSessionStorage;

  constructor(dbPath?: string) {
    this.storage = new SQLiteSessionStorage(dbPath);
  }

  async listSessions(limit: number = 50): Promise<SessionInfo[]> {
    const sessions = this.storage.listSessions(limit);

    return sessions.map((s) => ({
      id: s.id,
      metadata: {
        id: s.id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        name: s.name || undefined,
        model: s.model,
      },
      messageCount: s.message_count,
      model: s.model,
      cwd: s.cwd,
    }));
  }

  async createSession(cwd: string, model: string, name?: string): Promise<string> {
    // Ensure .euler directory exists
    const eulerDir = join(homedir(), '.euler');
    await mkdir(eulerDir, { recursive: true });

    return await this.storage.createSession(cwd, model, name);
  }

  async appendEntry(sessionId: string, entry: any): Promise<void> {
    await this.storage.appendEntry(sessionId, entry);
  }

  async getMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    return this.storage.getMessages(sessionId);
  }

  getMostRecentSession(): SessionRecord | null {
    return this.storage.getMostRecentSession();
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.storage.getSession(sessionId);
  }

  setCurrentSession(sessionId: string): void {
    this.storage.setCurrentSession(sessionId);
  }

  getCurrentSessionId(): string | null {
    return this.storage.getCurrentSession();
  }

  close(): void {
    this.storage.close();
  }
}
