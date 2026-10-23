import { z } from 'zod';
import { readFileSync } from 'node:fs';

export const AiConfig = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.url().default('https://api.deepseek.com'),
  apiKey: z.string().min(1),
  model: z.string().min(1).default('deepseek-flash'),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('low'),
  maxOutputTokens: z.number().int().min(1).max(16384).default(4096),
  requestTimeoutMs: z.number().int().min(1000).max(180000).default(90000),
}).strict();
export type AiConfig = z.infer<typeof AiConfig>;
export const AiSettings = AiConfig.omit({ apiKey: true }).extend({ apiKeyEnv: z.string().min(1).default('DEEPSEEK_API_KEY') }).strict();
export type AiSettings = z.infer<typeof AiSettings>;

export function aiConfigFromEnvironment(settings: AiSettings | undefined, environment: NodeJS.ProcessEnv = process.env) {
  if (!settings?.enabled) return undefined;
  const { apiKeyEnv, ...config } = settings; const apiKey = environment[apiKeyEnv];
  return apiKey ? AiConfig.parse({ ...config, apiKey }) : undefined;
}

export type AiContent = string | Array<{ type: 'text'; text: string } | { type: 'file'; file_id: string }>;
export type AiInputMessage = { role: 'system' | 'user' | 'assistant'; content: AiContent; name?: 'dva' | 'mercy' };
export type AiImageFile = { name: string; mime: string; size: number; path: string };
export interface AiClient { readonly model: string; stream(messages: AiInputMessage[], signal: AbortSignal): AsyncIterable<string>; uploadImage?(file: AiImageFile, signal: AbortSignal): Promise<{ fileId: string; expiresAt: string | null }>; }

export class DeepSeekClient implements AiClient {
  readonly model: string;
  constructor(private config: AiConfig) { this.model = config.model; }
  async uploadImage(file: AiImageFile, signal: AbortSignal) {
    const form = new FormData(); form.append('purpose', 'user_data'); form.append('expires_after[anchor]', 'created_at'); form.append('expires_after[seconds]', '604800');
    form.append('file', new Blob([readFileSync(file.path)], { type: file.mime }), file.name);
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/files`, { method: 'POST', signal, headers: { authorization: `Bearer ${this.config.apiKey}` }, body: form });
    if (!response.ok) throw new Error(`DeepSeek file upload failed (${response.status})`);
    const parsed = z.object({ id: z.string().min(1), expires_at: z.number().int().optional() }).safeParse(await response.json());
    if (!parsed.success) throw new Error('DeepSeek returned invalid file metadata');
    return { fileId: parsed.data.id, expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at * 1000).toISOString() : null };
  }
  async *stream(messages: AiInputMessage[], signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages, stream: true, reasoning_effort: this.config.reasoningEffort, max_tokens: this.config.maxOutputTokens }),
    });
    if (!response.ok || !response.body) throw new Error(`DeepSeek request failed (${response.status})`);
    const decoder = new TextDecoder(); let buffer = ''; const reader = response.body.getReader();
    while (true) {
      const item = await reader.read(); if (item.done) break; const chunk = item.value;
      buffer += decoder.decode(chunk, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const event = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length);
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
          let value: unknown; try { value = JSON.parse(data); } catch { throw new Error('DeepSeek returned invalid stream data'); }
          const parsed = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).passthrough() }).passthrough()) }).passthrough().safeParse(value);
          if (!parsed.success) throw new Error('DeepSeek returned an unexpected response');
          const text = parsed.data.choices[0]?.delta.content; if (text) yield text;
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
  }
}
