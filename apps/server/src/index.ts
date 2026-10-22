import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { createServer } from './app';
import { TurnConfig } from './ice';

const schema = z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(8787), database: z.string(), attachments: z.string().optional(), users: z.object({ dva: z.string().min(1), mercy: z.string().min(1) }) });
const path = resolve(process.env.DARLING_SERVER_CONFIG ?? 'server.config.json');
try {
  const config = schema.extend({ turn: TurnConfig.optional() }).parse(JSON.parse(readFileSync(path, 'utf8')));
  const database = resolve(dirname(path), config.database);
  mkdirSync(dirname(database), { recursive: true });
  const app = await createServer({ database, users: config.users, turn: config.turn, attachmentsDir: config.attachments ? resolve(dirname(path), config.attachments) : undefined });
  await app.listen({ host: config.host, port: config.port });
  console.log(`Darling listening on ${config.host}:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
} catch (error) {
  console.error(`无法启动服务，请检查配置 ${path}：${error instanceof Error ? error.name : '未知错误'}`);
  process.exitCode = 1;
}
