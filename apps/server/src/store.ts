import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AiGroupId, Attachment, GroupMessage, Message, User } from '../../../packages/protocol/src/index';

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS attachments(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(2);`);
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'attachmentId')) this.db.exec('ALTER TABLE messages ADD COLUMN attachmentId TEXT REFERENCES attachments(id)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, title TEXT NOT NULL, next_seq INTEGER NOT NULL, createdAt TEXT NOT NULL);
      INSERT OR IGNORE INTO groups(id,title,next_seq,createdAt) VALUES('dva-mercy-echo','D.Va、Mercy 与 Echo',1,datetime('now'));
      CREATE TABLE IF NOT EXISTS group_members(groupId TEXT NOT NULL,memberId TEXT NOT NULL,memberType TEXT NOT NULL,displayName TEXT NOT NULL,PRIMARY KEY(groupId,memberId));
      INSERT OR IGNORE INTO group_members VALUES('dva-mercy-echo','dva','human','D.Va');
      INSERT OR IGNORE INTO group_members VALUES('dva-mercy-echo','mercy','human','Mercy');
      INSERT OR IGNORE INTO group_members VALUES('dva-mercy-echo','echo','assistant','Echo');
      CREATE TABLE IF NOT EXISTS group_messages(id TEXT PRIMARY KEY,groupId TEXT NOT NULL,clientId TEXT NOT NULL,sender TEXT NOT NULL,messageType TEXT NOT NULL,text TEXT NOT NULL,seq INTEGER NOT NULL,createdAt TEXT NOT NULL,UNIQUE(groupId,seq),UNIQUE(groupId,sender,clientId));
      INSERT OR IGNORE INTO schema_migrations VALUES(3);`);
  }
  private row(value: Record<string, unknown>): Message {
    const attachment = value.attachmentId ? { id: value.attachmentId, name: value.attachmentName, mime: value.attachmentMime, size: value.attachmentSize } as Attachment : undefined;
    return { id: value.id, clientId: value.clientId, sender: value.sender, text: value.text, seq: value.seq, createdAt: value.createdAt, ...(attachment ? { attachment } : {}) } as Message;
  }
  save(sender: User, clientId: string, text: string): { message: Message; inserted: boolean } {
    const existing = this.db.prepare(`SELECT m.id,m.clientId,m.sender,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM messages m LEFT JOIN attachments a ON a.id=m.attachmentId WHERE m.sender=? AND m.clientId=?`).get(sender, clientId) as Record<string, unknown> | undefined;
    if (existing) return { message: this.row(existing), inserted: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare("SELECT next_seq FROM conversations WHERE id='dva-mercy'").get() as { next_seq: number };
      const message: Message = { id: randomUUID(), clientId, sender, text, seq: next_seq, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO messages(id,clientId,sender,text,seq,createdAt) VALUES(?,?,?,?,?,?)').run(message.id, clientId, sender, text, next_seq, message.createdAt);
      this.db.exec("UPDATE conversations SET next_seq=next_seq+1 WHERE id='dva-mercy'; COMMIT");
      return { message, inserted: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveAttachment(sender: User, clientId: string, attachment: Attachment, path: string): { message: Message; inserted: boolean } {
    const existing = this.db.prepare(`SELECT m.id,m.clientId,m.sender,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM messages m LEFT JOIN attachments a ON a.id=m.attachmentId WHERE m.sender=? AND m.clientId=?`).get(sender, clientId) as Record<string, unknown> | undefined;
    if (existing) return { message: this.row(existing), inserted: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare("SELECT next_seq FROM conversations WHERE id='dva-mercy'").get() as { next_seq: number };
      const message: Message = { id: randomUUID(), clientId, sender, text: '', attachment, seq: next_seq, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO attachments(id,name,mime,size,path) VALUES(?,?,?,?,?)').run(attachment.id, attachment.name, attachment.mime, attachment.size, path);
      this.db.prepare('INSERT INTO messages(id,clientId,sender,text,seq,createdAt,attachmentId) VALUES(?,?,?,?,?,?,?)').run(message.id, clientId, sender, '', next_seq, message.createdAt, attachment.id);
      this.db.exec("UPDATE conversations SET next_seq=next_seq+1 WHERE id='dva-mercy'; COMMIT"); return { message, inserted: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  attachment(id: string) { return this.db.prepare('SELECT id,name,mime,size,path FROM attachments WHERE id=?').get(id) as (Attachment & { path: string }) | undefined; }
  page(after: number) {
    const rows = this.db.prepare(`SELECT m.id,m.clientId,m.sender,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM messages m LEFT JOIN attachments a ON a.id=m.attachmentId WHERE m.seq>? ORDER BY m.seq LIMIT 101`).all(after) as Array<Record<string, unknown>>;
    const messages = rows.slice(0, 100).map(row => this.row(row));
    return { messages, hasMore: rows.length > 100, next: messages.at(-1)?.seq ?? after };
  }
  saveGroup(groupId: AiGroupId, sender: User, clientId: string, text: string): { message: GroupMessage; inserted: boolean } {
    const existing = this.db.prepare('SELECT id,groupId,clientId,sender,messageType,text,seq,createdAt FROM group_messages WHERE groupId=? AND sender=? AND clientId=?').get(groupId, sender, clientId) as GroupMessage | undefined;
    if (existing) return { message: existing, inserted: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare('SELECT next_seq FROM groups WHERE id=?').get(groupId) as { next_seq: number };
      const message: GroupMessage = { id: randomUUID(), groupId, clientId, sender, messageType: 'text', text, seq: next_seq, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO group_messages(id,groupId,clientId,sender,messageType,text,seq,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(message.id, groupId, clientId, sender, message.messageType, text, next_seq, message.createdAt);
      this.db.prepare('UPDATE groups SET next_seq=next_seq+1 WHERE id=?').run(groupId); this.db.exec('COMMIT'); return { message, inserted: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  groupPage(groupId: AiGroupId, after: number) {
    const rows = this.db.prepare('SELECT id,groupId,clientId,sender,messageType,text,seq,createdAt FROM group_messages WHERE groupId=? AND seq>? ORDER BY seq LIMIT 101').all(groupId, after) as GroupMessage[];
    const messages = rows.slice(0, 100);
    return { groupId, messages, hasMore: rows.length > 100, next: messages.at(-1)?.seq ?? after };
  }
  close() { this.db.close(); }
}
