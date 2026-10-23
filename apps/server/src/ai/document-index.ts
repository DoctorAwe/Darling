import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { AiGroupId, Attachment } from '../../../../packages/protocol/src/index';
import type { MessageStore } from '../store';

const supported = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.java', '.go', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.sql', '.sh', '.ps1']);
const maxBytes = 8 * 1024 * 1024;

function terms(input: string) {
  const lower = input.toLocaleLowerCase(); const result = new Set(lower.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]/g) ?? []);
  const chinese = [...lower].filter(value => /[\u3400-\u9fff]/.test(value));
  for (let index = 0; index + 1 < chinese.length; index++) result.add(chinese[index] + chinese[index + 1]);
  return [...result].slice(0, 128);
}

export class DocumentIndex {
  constructor(private store: MessageStore) {}
  private supported(attachment: Attachment) { return attachment.size <= maxBytes && (attachment.mime.startsWith('text/') || supported.has(extname(attachment.name).toLocaleLowerCase())); }
  ensure(groupId: AiGroupId, attachmentId: string) {
    const attachment = this.store.groupAttachment(attachmentId); if (!attachment || attachment.groupId !== groupId || !this.supported(attachment)) return false;
    if (attachment.analysisStatus === 'ready') return true;
    try {
      this.store.setGroupAttachmentAnalysis(attachmentId, 'extracting');
      const bytes = readFileSync(attachment.path); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\0/g, '');
      if (!text.trim()) throw new Error('empty document');
      const chunks: Array<{ content: string; location: string; tokenEstimate: number }> = [];
      const size = 3200, overlap = 320;
      for (let start = 0, index = 0; start < text.length; start += size - overlap, index++) {
        const content = text.slice(start, start + size).trim(); if (content) chunks.push({ content, location: `字符 ${start + 1}–${Math.min(text.length, start + size)}`, tokenEstimate: Math.ceil(content.length / 2.5) });
        if (chunks.length >= 512) break;
      }
      this.store.replaceDocumentChunks(attachmentId, chunks); this.store.setGroupAttachmentAnalysis(attachmentId, 'ready'); return true;
    } catch { this.store.setGroupAttachmentAnalysis(attachmentId, 'failed'); return false; }
  }
  search(groupId: AiGroupId, attachmentIds: string[], query: string, limit = 6) {
    const queryTerms = terms(query); const candidates: Array<{ attachmentId: string; name: string; content: string; location: string; score: number }> = [];
    for (const attachmentId of attachmentIds) {
      if (!this.ensure(groupId, attachmentId)) continue;
      const attachment = this.store.groupAttachment(attachmentId)!;
      for (const chunk of this.store.documentChunks(attachmentId)) {
        const haystack = chunk.content.toLocaleLowerCase(); let score = 0;
        for (const term of queryTerms) if (haystack.includes(term)) score += term.length > 1 ? 3 : 1;
        candidates.push({ attachmentId, name: attachment.name, content: chunk.content, location: chunk.location, score });
      }
    }
    return candidates.sort((a, b) => b.score - a.score || a.location.localeCompare(b.location)).slice(0, limit);
  }
}
