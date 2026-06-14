/**
 * Session types for Euler Agent
 */

export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  name?: string;
  model: string;
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntry {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface SessionInfoEntry extends SessionEntry {
  type: 'session_info';
  name: string;
}

export type Entry = MessageEntry | SessionInfoEntry;

export interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(id: string | null): Promise<void>;
  getEntries(): Promise<Entry[]>;
  appendEntry(entry: Entry): Promise<void>;
  createEntryId(): Promise<string>;
}
