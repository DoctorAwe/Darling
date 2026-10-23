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
      CREATE TABLE IF NOT EXISTS group_messages(id TEXT PRIMARY KEY,groupId TEXT NOT NULL,clientId TEXT NOT NULL,sender TEXT NOT NULL,messageType TEXT NOT NULL,text TEXT NOT NULL,seq INTEGER NOT NULL,createdAt TEXT NOT NULL,attachmentId TEXT,aiRequestId TEXT,aiModel TEXT,UNIQUE(groupId,seq),UNIQUE(groupId,sender,clientId));
      CREATE TABLE IF NOT EXISTS group_attachments(id TEXT PRIMARY KEY,groupId TEXT NOT NULL,uploader TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,analysisStatus TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_file_bindings(attachmentId TEXT NOT NULL,provider TEXT NOT NULL,providerFileId TEXT NOT NULL,expiresAt TEXT,createdAt TEXT NOT NULL,PRIMARY KEY(attachmentId,provider));
      CREATE TABLE IF NOT EXISTS document_chunks(id TEXT PRIMARY KEY,attachmentId TEXT NOT NULL,chunkIndex INTEGER NOT NULL,content TEXT NOT NULL,location TEXT NOT NULL,tokenEstimate INTEGER NOT NULL,UNIQUE(attachmentId,chunkIndex));
      INSERT OR IGNORE INTO schema_migrations VALUES(3);`);
    const groupColumns = this.db.prepare('PRAGMA table_info(group_messages)').all() as Array<{ name: string }>;
    if (!groupColumns.some(column => column.name === 'aiRequestId')) this.db.exec('ALTER TABLE group_messages ADD COLUMN aiRequestId TEXT');
    if (!groupColumns.some(column => column.name === 'aiModel')) this.db.exec('ALTER TABLE group_messages ADD COLUMN aiModel TEXT');
    if (!groupColumns.some(column => column.name === 'attachmentId')) this.db.exec('ALTER TABLE group_messages ADD COLUMN attachmentId TEXT');
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
    const existing = this.groupMessage(groupId, sender, clientId);
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
    const rows = this.db.prepare(`SELECT m.id,m.groupId,m.clientId,m.sender,m.messageType,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM group_messages m LEFT JOIN group_attachments a ON a.id=m.attachmentId WHERE m.groupId=? AND m.seq>? ORDER BY m.seq LIMIT 101`).all(groupId, after) as Array<Record<string, unknown>>;
    const messages = rows.slice(0, 100).map(row => this.groupRow(row));
    return { groupId, messages, hasMore: rows.length > 100, next: messages.at(-1)?.seq ?? after };
  }
  groupRecent(groupId: AiGroupId, throughSeq: number, limit: number) {
    return (this.db.prepare(`SELECT m.id,m.groupId,m.clientId,m.sender,m.messageType,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM group_messages m LEFT JOIN group_attachments a ON a.id=m.attachmentId WHERE m.groupId=? AND m.seq<=? ORDER BY m.seq DESC LIMIT ?`).all(groupId, throughSeq, limit) as Array<Record<string, unknown>>).reverse().map(row => this.groupRow(row));
  }
  private groupRow(value: Record<string, unknown>): GroupMessage {
    const attachment = value.attachmentId ? { id: value.attachmentId, name: value.attachmentName, mime: value.attachmentMime, size: value.attachmentSize } as Attachment : undefined;
    return { id: value.id, groupId: value.groupId, clientId: value.clientId, sender: value.sender, messageType: value.messageType, text: value.text, seq: value.seq, createdAt: value.createdAt, ...(attachment ? { attachment } : {}) } as GroupMessage;
  }
  private groupMessage(groupId: AiGroupId, sender: User, clientId: string) {
    const row = this.db.prepare(`SELECT m.id,m.groupId,m.clientId,m.sender,m.messageType,m.text,m.seq,m.createdAt,m.attachmentId,a.name attachmentName,a.mime attachmentMime,a.size attachmentSize
      FROM group_messages m LEFT JOIN group_attachments a ON a.id=m.attachmentId WHERE m.groupId=? AND m.sender=? AND m.clientId=?`).get(groupId, sender, clientId) as Record<string, unknown> | undefined;
    return row ? this.groupRow(row) : undefined;
  }
  saveGroupAttachment(groupId: AiGroupId, sender: User, clientId: string, attachment: Attachment, path: string): { message: GroupMessage; inserted: boolean } {
    const existing = this.groupMessage(groupId, sender, clientId); if (existing) return { message: existing, inserted: false };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare('SELECT next_seq FROM groups WHERE id=?').get(groupId) as { next_seq: number };
      const createdAt = new Date().toISOString(); const message: GroupMessage = { id: randomUUID(), groupId, clientId, sender, messageType: 'attachment', text: '', attachment, seq: next_seq, createdAt };
      this.db.prepare('INSERT INTO group_attachments(id,groupId,uploader,name,mime,size,path,analysisStatus,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(attachment.id, groupId, sender, attachment.name, attachment.mime, attachment.size, path, 'not_requested', createdAt);
      this.db.prepare('INSERT INTO group_messages(id,groupId,clientId,sender,messageType,text,seq,createdAt,attachmentId) VALUES(?,?,?,?,?,?,?,?,?)').run(message.id, groupId, clientId, sender, 'attachment', '', next_seq, createdAt, attachment.id);
      this.db.prepare('UPDATE groups SET next_seq=next_seq+1 WHERE id=?').run(groupId); this.db.exec('COMMIT'); return { message, inserted: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  groupAttachment(id: string) { return this.db.prepare('SELECT id,groupId,uploader,name,mime,size,path,analysisStatus,createdAt FROM group_attachments WHERE id=?').get(id) as (Attachment & { groupId: AiGroupId; uploader: User; path: string; analysisStatus: string; createdAt: string }) | undefined; }
  aiFileBinding(attachmentId: string) { return this.db.prepare("SELECT providerFileId,expiresAt FROM ai_file_bindings WHERE attachmentId=? AND provider='deepseek'").get(attachmentId) as { providerFileId: string; expiresAt: string | null } | undefined; }
  saveAiFileBinding(attachmentId: string, providerFileId: string, expiresAt: string | null) { this.db.prepare("INSERT OR REPLACE INTO ai_file_bindings(attachmentId,provider,providerFileId,expiresAt,createdAt) VALUES(?,'deepseek',?,?,?)").run(attachmentId, providerFileId, expiresAt, new Date().toISOString()); }
  setGroupAttachmentAnalysis(attachmentId: string, status: 'extracting' | 'ready' | 'failed') { this.db.prepare('UPDATE group_attachments SET analysisStatus=? WHERE id=?').run(status, attachmentId); }
  replaceDocumentChunks(attachmentId: string, chunks: Array<{ content: string; location: string; tokenEstimate: number }>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM document_chunks WHERE attachmentId=?').run(attachmentId);
      const insert = this.db.prepare('INSERT INTO document_chunks(id,attachmentId,chunkIndex,content,location,tokenEstimate) VALUES(?,?,?,?,?,?)');
      chunks.forEach((chunk, index) => insert.run(randomUUID(), attachmentId, index, chunk.content, chunk.location, chunk.tokenEstimate)); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  documentChunks(attachmentId: string) { return this.db.prepare('SELECT content,location,tokenEstimate FROM document_chunks WHERE attachmentId=? ORDER BY chunkIndex').all(attachmentId) as Array<{ content: string; location: string; tokenEstimate: number }>; }
  saveAssistant(groupId: AiGroupId, requestId: string, text: string, model: string): GroupMessage {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next_seq } = this.db.prepare('SELECT next_seq FROM groups WHERE id=?').get(groupId) as { next_seq: number };
      const message: GroupMessage = { id: randomUUID(), groupId, clientId: requestId, sender: 'echo', messageType: 'assistant', text, seq: next_seq, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO group_messages(id,groupId,clientId,sender,messageType,text,seq,createdAt,aiRequestId,aiModel) VALUES(?,?,?,?,?,?,?,?,?,?)').run(message.id, groupId, requestId, 'echo', 'assistant', text, next_seq, message.createdAt, requestId, model);
      this.db.prepare('UPDATE groups SET next_seq=next_seq+1 WHERE id=?').run(groupId); this.db.exec('COMMIT'); return message;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
