/**
 * SQLite-based session storage - Pi-style session management (Bun-compatible)
 */

import Database from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import type { SessionMetadata, Entry } from './types';

export interface SessionRecord {
  id: string;
  created_at: number;
  updated_at: number;
  name: string | null;
  model: string;
  cwd: string;
  message_count: number;
}

export class SQLiteSessionStorage {
  private db: Database;
  private currentSessionId: string | null = null;

  constructor(dbPath?: string) {
    const defaultPath = join(homedir(), '.euler', 'sessions.db');
    const path = dbPath || defaultPath;
    this.db = new Database(path);
    this.initialize();
  }

  private initialize(): void {
    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        name TEXT,
        model TEXT NOT NULL,
        cwd TEXT NOT NULL,
        message_count INTEGER DEFAULT 0
      )
    `);

    // Create entries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for better performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entries_parent_id ON entries(parent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    `);
  }

  async createSession(cwd: string, model: string, name?: string): Promise<string> {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    this.db.query(`
      INSERT INTO sessions (id, created_at, updated_at, name, model, cwd, message_count)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(sessionId, now, now, name || null, model, cwd);

    this.currentSessionId = sessionId;
    return sessionId;
  }

  async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.updated_at !== undefined) {
      fields.push('updated_at = ?');
      values.push(updates.updated_at);
    }
    if (updates.message_count !== undefined) {
      fields.push('message_count = ?');
      values.push(updates.message_count);
    }

    if (fields.length > 0) {
      values.push(sessionId);
      this.db.query(`
        UPDATE sessions SET ${fields.join(', ')} WHERE id = ?
      `).run(...values);
    }
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.query(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId) as SessionRecord | undefined;

    return row || null;
  }

  listSessions(limit: number = 50): SessionRecord[] {
    const rows = this.db.query(`
      SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as SessionRecord[];

    return rows;
  }

  async appendEntry(sessionId: string, entry: Entry): Promise<void> {
    const now = new Date().toISOString();

    this.db.query(`
      INSERT INTO entries (id, session_id, parent_id, type, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      sessionId,
      entry.parentId || null,
      entry.type,
      entry.type === 'message' ? entry.role : null,
      entry.type === 'message' ? entry.content : null,
      now
    );

    // Update session timestamp and message count
    const currentSession = this.getSession(sessionId);
    if (currentSession) {
      await this.updateSession(sessionId, {
        updated_at: Date.now(),
        message_count: currentSession.message_count + (entry.type === 'message' ? 1 : 0),
      });
    }
  }

  getEntries(sessionId: string): Entry[] {
    const rows = this.db.query(`
      SELECT * FROM entries WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId) as any[];

    return rows.map(row => ({
      id: row.id,
      parentId: row.parentId,
      type: row.type,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    }));
  }

  getMessages(sessionId: string): Array<{ role: string; content: string }> {
    const rows = this.db.query(`
      SELECT role, content FROM entries
      WHERE session_id = ? AND type = 'message'
      ORDER BY timestamp ASC
    `).all(sessionId) as any[];

    return rows.map(row => ({
      role: row.role,
      content: row.content,
    }));
  }

  deleteSession(sessionId: string): void {
    this.db.query('DELETE FROM entries WHERE session_id = ?').run(sessionId);
    this.db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  setCurrentSession(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  getCurrentSession(): string | null {
    return this.currentSessionId;
  }

  getMostRecentSession(): SessionRecord | null {
    const row = this.db.query(`
      SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1
    `).get() as SessionRecord | undefined;

    return row || null;
  }

  close(): void {
    this.db.close();
  }
}
