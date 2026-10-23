import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { AiGroupId, Attachment } from '../../../../packages/protocol/src/index';
import type { MessageStore } from '../store';

const textExtensions = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.java', '.go', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.sql', '.sh', '.ps1']);
const maxBytes = 16 * 1024 * 1024;
const maxPdfPages = 200;
const chunkSize = 3200;
const overlap = 320;
const extractionTimeoutMs = 15_000;
type Chunk = { content: string; location: string; tokenEstimate: number };

function terms(input: string) {
  const lower = input.toLocaleLowerCase(); const result = new Set(lower.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]/g) ?? []);
  const chinese = [...lower].filter(value => /[\u3400-\u9fff]/.test(value));
  for (let index = 0; index + 1 < chinese.length; index++) result.add(chinese[index] + chinese[index + 1]);
  return [...result].slice(0, 128);
}

function pushChunks(target: Chunk[], text: string, location: (start: number, end: number) => string) {
  for (let start = 0; start < text.length && target.length < 512; start += chunkSize - overlap) {
    const end = Math.min(text.length, start + chunkSize); const content = text.slice(start, end).trim();
    if (content) target.push({ content, location: location(start, end), tokenEstimate: Math.ceil(content.length / 2.5) });
  }
}

async function withTimeout<T>(work: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('document extraction timeout')), extractionTimeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function kind(attachment: Attachment) {
  const extension = extname(attachment.name).toLocaleLowerCase();
  if (extension === '.pdf' || attachment.mime === 'application/pdf') return 'pdf';
  if (extension === '.docx' || attachment.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (attachment.mime.startsWith('text/') || textExtensions.has(extension)) return 'text';
  return undefined;
}

export class DocumentIndex {
  constructor(private store: MessageStore) {}
  private async extract(attachment: Attachment & { path: string }): Promise<Chunk[]> {
    const bytes = await readFile(attachment.path); const format = kind(attachment); const chunks: Chunk[] = [];
    if (format === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
      try {
        if (pdf.numPages > maxPdfPages) throw new Error('too many PDF pages');
        const result = await extractText(pdf, { mergePages: false }); const pages = Array.isArray(result.text) ? result.text : [result.text];
        pages.forEach((page, index) => pushChunks(chunks, page, (start, end) => `第 ${index + 1} 页，字符 ${start + 1}–${end}`));
      } finally { await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.(); }
    } else if (format === 'docx') {
      const result = await mammoth.extractRawText({ buffer: bytes });
      const paragraphs = result.value.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
      paragraphs.forEach((paragraph, index) => pushChunks(chunks, paragraph, (start, end) => `第 ${index + 1} 段，字符 ${start + 1}–${end}`));
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\0/g, '');
      pushChunks(chunks, text, (start, end) => `字符 ${start + 1}–${end}`);
    }
    if (!chunks.length) throw new Error('empty document');
    return chunks;
  }
  async ensure(groupId: AiGroupId, attachmentId: string) {
    const attachment = this.store.groupAttachment(attachmentId); if (!attachment || attachment.groupId !== groupId || attachment.size > maxBytes || !kind(attachment)) return false;
    if (attachment.analysisStatus === 'ready') return true;
    try {
      this.store.setGroupAttachmentAnalysis(attachmentId, 'extracting');
      this.store.replaceDocumentChunks(attachmentId, await withTimeout(this.extract(attachment)));
      this.store.setGroupAttachmentAnalysis(attachmentId, 'ready'); return true;
    } catch { this.store.setGroupAttachmentAnalysis(attachmentId, 'failed'); return false; }
  }
  async search(groupId: AiGroupId, attachmentIds: string[], query: string, limit = 6) {
    const queryTerms = terms(query); const candidates: Array<{ attachmentId: string; name: string; content: string; location: string; score: number }> = [];
    for (const attachmentId of attachmentIds) {
      if (!await this.ensure(groupId, attachmentId)) continue;
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
