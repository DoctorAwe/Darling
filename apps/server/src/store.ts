import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Message, User } from '../../../packages/protocol/src/index';

export class MessageStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO conversations VALUES('dva-mercy', 1);
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, clientId TEXT NOT NULL, sender TEXT NOT NULL,
        text TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE, createdAt TEXT NOT NULL,
        conversationId TEXT NOT NULL DEFAULT 'dva-mercy', UNIQUE(sender, clientId));
      INSERT OR IGNORE INTO schema_migrations VALUES(1);`);
  }
  save(sender: User, clientId: string, text: string): { message: Message; inserted: boolean } {
    const existing = this.db.prepare('SELECT id,clientId,sender,text,seq,createdAt FROM messages WHERE sender=? AND clientId=?').get(sender, clientId) as Message | undefined;
    if (existing) return { message: existing, inserted: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare("SELECT next_seq FROM conversations WHERE id='dva-mercy'").get() as { next_seq: number };
      const message: Message = { id: randomUUID(), clientId, sender, text, seq: next_seq, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO messages(id,clientId,sender,text,seq,createdAt) VALUES(?,?,?,?,?,?)').run(message.id, clientId, sender, text, next_seq, message.createdAt);
      this.db.exec("UPDATE conversations SET next_seq=next_seq+1 WHERE id='dva-mercy'; COMMIT");
      return { message, inserted: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  page(after: number) {
    const rows = this.db.prepare('SELECT id,clientId,sender,text,seq,createdAt FROM messages WHERE seq>? ORDER BY seq LIMIT 101').all(after) as Message[];
    const messages = rows.slice(0, 100);
    return { messages, hasMore: rows.length > 100, next: messages.at(-1)?.seq ?? after };
  }
  close() { this.db.close(); }
}
