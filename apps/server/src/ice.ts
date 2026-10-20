import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { IceConfig, User } from '../../../packages/protocol/src/index';

export const TurnConfig = z.object({
  publicIp: z.ipv4(), port: z.number().int().min(1).max(65535).default(3478),
  secret: z.string().regex(/^[a-fA-F0-9]{64}$/, 'TURN secret 必须为 32 字节随机值的十六进制文本'),
  ttlSeconds: z.number().int().min(300).max(86400).default(3600),
}).strict();
export type TurnConfig = z.infer<typeof TurnConfig>;

export function issueIce(config: TurnConfig | undefined, user: User, now = Date.now()): IceConfig {
  if (!config) return { iceServers: [], expiresAt: null };
  const expires = Math.floor(now / 1000) + config.ttlSeconds;
  const username = `${expires}:${user}`;
  // coturn REST auth uses the configured text secret, not hex-decoded bytes.
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  const address = `${config.publicIp}:${config.port}`;
  return { expiresAt: expires * 1000, iceServers: [
    { urls: [`stun:${address}`] },
    { urls: [`turn:${address}?transport=udp`, `turn:${address}?transport=tcp`], username, credential },
  ] };
}
