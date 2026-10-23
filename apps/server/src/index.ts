import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { createServer } from './app';
import { TurnConfig } from './ice';
import { AiConfig, DeepSeekClient } from './ai/deepseek-client';

const schema = z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(8787), database: z.string(), attachments: z.string().optional(), users: z.object({ dva: z.string().min(1), mercy: z.string().min(1) }), ai: z.object({ enabled: z.boolean().default(true), baseUrl: z.url().default('https://api.deepseek.com'), apiKeyEnv: z.string().min(1).default('DEEPSEEK_API_KEY'), model: z.string().min(1).default('deepseek-flash'), reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('low'), maxOutputTokens: z.number().int().min(1).max(16384).default(4096), requestTimeoutMs: z.number().int().min(1000).max(180000).default(90000) }).optional() });
const path = resolve(process.env.DARLING_SERVER_CONFIG ?? 'server.config.json');
try {
  const config = schema.extend({ turn: TurnConfig.optional() }).parse(JSON.parse(readFileSync(path, 'utf8')));
  const database = resolve(dirname(path), config.database);
  mkdirSync(dirname(database), { recursive: true });
  const key = config.ai?.enabled ? process.env[config.ai.apiKeyEnv] : undefined;
  const aiConfig = key && config.ai ? AiConfig.parse({ ...config.ai, apiKey: key }) : undefined;
  const app = await createServer({ database, users: config.users, turn: config.turn, attachmentsDir: config.attachments ? resolve(dirname(path), config.attachments) : undefined, aiClient: aiConfig ? new DeepSeekClient(aiConfig) : undefined, aiTimeoutMs: aiConfig?.requestTimeoutMs });
  await app.listen({ host: config.host, port: config.port });
  console.log(`Darling listening on ${config.host}:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
} catch (error) {
  console.error(`无法启动服务，请检查配置 ${path}：${error instanceof Error ? error.name : '未知错误'}`);
  process.exitCode = 1;
}
