import { z } from 'zod';

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

export type AiInputMessage = { role: 'system' | 'user' | 'assistant'; content: string; name?: 'dva' | 'mercy' };
export interface AiClient { readonly model: string; stream(messages: AiInputMessage[], signal: AbortSignal): AsyncIterable<string>; }

export class DeepSeekClient implements AiClient {
  readonly model: string;
  constructor(private config: AiConfig) { this.model = config.model; }
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
