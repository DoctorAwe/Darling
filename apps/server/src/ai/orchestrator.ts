import { randomUUID } from 'node:crypto';
import type { AiGroupId, GroupMessage } from '../../../../packages/protocol/src/index';
import type { MessageStore } from '../store';
import type { AiClient, AiInputMessage } from './deepseek-client';

const persona = `你是 Darling 群聊中的 AI 助手 Echo。群内有两位真人用户：dva 对应 D.Va，mercy 对应 Mercy。必须准确区分两人的身份、观点、要求和上传内容；引用观点时注明说话人；“你们”代表两位真人用户。回答自然、简洁、友好。不得声称读取过没有提供或解析失败的文件。`;

export type AiEvent =
  | { type: 'started'; groupId: AiGroupId; requestId: string; triggerMessageId: string }
  | { type: 'delta'; groupId: AiGroupId; requestId: string; delta: string }
  | { type: 'completed'; groupId: AiGroupId; requestId: string; message: GroupMessage }
  | { type: 'failed'; groupId: AiGroupId; requestId: string; error: string };

export class AiOrchestrator {
  private queue = Promise.resolve();
  private active?: { requestId: string; controller: AbortController; cancelled: boolean };
  constructor(private store: MessageStore, private client: AiClient | undefined, private publish: (event: AiEvent) => void, private timeoutMs = 90000) {}
  get available() { return !!this.client; }
  enqueue(trigger: GroupMessage) {
    if (!/@echo\b/i.test(trigger.text)) return;
    const requestId = randomUUID();
    if (!this.client) { this.publish({ type: 'failed', groupId: trigger.groupId, requestId, error: 'Echo 暂时不可用' }); return; }
    this.queue = this.queue.then(() => this.run(trigger, requestId)).catch(() => {});
  }
  cancel(requestId: string) {
    if (!this.active || this.active.requestId !== requestId) return false;
    this.active.cancelled = true; this.active.controller.abort(); return true;
  }
  private async context(groupId: AiGroupId, throughSeq: number, signal: AbortSignal): Promise<AiInputMessage[]> {
    const history = this.store.groupRecent(groupId, throughSeq, 60);
    const eligible = history.filter(message => message.attachment && message.attachment.size <= 64 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(message.attachment.mime)).slice(-4);
    const files = new Map<string, string>();
    if (this.client?.uploadImage) for (const message of eligible) {
      const attachment = this.store.groupAttachment(message.attachment!.id); if (!attachment) continue;
      const cached = this.store.aiFileBinding(attachment.id);
      if (cached && (!cached.expiresAt || Date.parse(cached.expiresAt) > Date.now() + 60000)) files.set(attachment.id, cached.providerFileId);
      else {
        const uploaded = await this.client.uploadImage(attachment, signal); this.store.saveAiFileBinding(attachment.id, uploaded.fileId, uploaded.expiresAt); files.set(attachment.id, uploaded.fileId);
      }
    }
    return [{ role: 'system', content: persona }, ...history.map(message => {
      if (message.sender === 'echo') return { role: 'assistant' as const, content: message.text };
      const fileId = message.attachment && files.get(message.attachment.id);
      const label = message.attachment ? `[${fileId ? '图片' : '附件'}：${message.attachment.name}]` : message.text;
      return { role: 'user' as const, name: message.sender, content: fileId ? [{ type: 'text' as const, text: label }, { type: 'file' as const, file_id: fileId }] : label };
    })];
  }
  private async run(trigger: GroupMessage, requestId: string) {
    const client = this.client!; const controller = new AbortController(); const active = this.active = { requestId, controller, cancelled: false }; const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.publish({ type: 'started', groupId: trigger.groupId, requestId, triggerMessageId: trigger.id });
    try {
      let answer = '';
      const context = await this.context(trigger.groupId, trigger.seq, controller.signal);
      for await (const delta of client.stream(context, controller.signal)) {
        answer += delta;
        if (answer.length > 64000) throw new Error('Echo 回答过长');
        this.publish({ type: 'delta', groupId: trigger.groupId, requestId, delta });
      }
      if (!answer.trim()) throw new Error('Echo 没有返回内容');
      const message = this.store.saveAssistant(trigger.groupId, requestId, answer, client.model);
      this.publish({ type: 'completed', groupId: trigger.groupId, requestId, message });
    } catch (error) {
      this.publish({ type: 'failed', groupId: trigger.groupId, requestId, error: active.cancelled ? '已停止生成' : error instanceof Error && error.name === 'AbortError' ? 'Echo 回答超时，请重试' : 'Echo 暂时无法回答' });
    } finally { clearTimeout(timer); if (this.active?.requestId === requestId) this.active = undefined; }
  }
}
