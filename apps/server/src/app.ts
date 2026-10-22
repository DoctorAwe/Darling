import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { ClientPacket, User, type ServerPacket } from '../../../packages/protocol/src/index';
import { MessageStore } from './store';
import { Calls } from './calls';
import { otherUser } from '../../../packages/protocol/src/index';
import { TurnConfig, issueIce } from './ice';
import { RemoteDesktops } from './remote-desktops';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Attachment } from '../../../packages/protocol/src/index';

export async function createServer(options: { database: string; users: Record<User, string>; turn?: TurnConfig; attachmentsDir?: string }) {
  const turn = options.turn === undefined ? undefined : TurnConfig.parse(options.turn);
  const app = Fastify({ logger: false });
  const store = new MessageStore(options.database);
  const temporaryAttachments = options.database === ':memory:' && !options.attachmentsDir;
  const attachmentsDir = options.attachmentsDir ?? (temporaryAttachments ? mkdtempSync(join(tmpdir(), 'darling-attachments-')) : join(dirname(options.database), 'attachments'));
  mkdirSync(attachmentsDir, { recursive: true });
  const sessions = new Map<User, WebSocket>();
  const sockets = new Set<WebSocket>();
  const send = (socket: WebSocket, packet: ServerPacket) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow client'); return; }
    socket.send(JSON.stringify(packet));
  };
  const presence = () => {
    const packet: ServerPacket = { version: 1, type: 'presence.changed', payload: { online: [...sessions.keys()] } };
    for (const socket of sessions.values()) send(socket, packet);
  };
  const publishMessage = (message: ReturnType<MessageStore['page']>['messages'][number]) => {
    for (const socket of sessions.values()) send(socket, { version: 1, type: 'message.stored', payload: message });
  };
  const httpUser = (headers: Record<string, string | string[] | undefined>) => {
    const parsed = User.safeParse(headers['x-darling-user']); const password = headers['x-darling-password'];
    return parsed.success && typeof password === 'string' && options.users[parsed.data] === password && sessions.has(parsed.data) ? parsed.data : undefined;
  };
  const calls = new Calls(call => {
    for (const socket of sessions.values()) send(socket, { version: 1, type: 'call.state', payload: { call } });
  });
  const remotes = new RemoteDesktops(session => {
    for (const socket of sessions.values()) send(socket, { version: 1, type: 'remote.state', payload: { session } });
  }, 30000);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 128 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.get('/health', async () => ({ ok: true, protocolVersion: 1, media: false }));
  app.post('/attachments', { bodyLimit: 128 * 1024 * 1024 }, async (request, reply) => {
    const user = httpUser(request.headers); if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const clientId = request.headers['x-client-id']; const encodedName = request.headers['x-file-name']; const mime = request.headers['x-mime-type']; const body = request.body;
    if (typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientId) || typeof encodedName !== 'string' || typeof mime !== 'string' || !Buffer.isBuffer(body)) return reply.code(400).send({ error: 'INVALID_ATTACHMENT' });
    let name = ''; try { name = decodeURIComponent(encodedName).replace(/[\\/\0-\x1f]/g, '_').trim(); } catch { return reply.code(400).send({ error: 'INVALID_NAME' }); }
    const attachment = Attachment.safeParse({ id: randomUUID(), name, mime, size: body.length }); if (!attachment.success) return reply.code(400).send({ error: 'INVALID_ATTACHMENT' });
    const path = join(attachmentsDir, `${attachment.data.id}.bin`); writeFileSync(path, body, { flag: 'wx' });
    try {
      const result = store.saveAttachment(user, clientId, attachment.data, path);
      if (!result.inserted) rmSync(path, { force: true }); else publishMessage(result.message);
      return reply.code(result.inserted ? 201 : 200).send({ message: result.message });
    } catch (error) { rmSync(path, { force: true }); throw error; }
  });
  app.get('/attachments/:id', async (request, reply) => {
    const user = httpUser(request.headers); if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const id = (request.params as { id?: string }).id; const attachment = typeof id === 'string' ? store.attachment(id) : undefined;
    if (!attachment) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.type(attachment.mime).header('content-length', attachment.size).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`).send(readFileSync(attachment.path));
  });
  app.get('/ws', { websocket: true }, socket => {
    sockets.add(socket);
    let user: User | undefined;
    let alive = true;
    const loginTimeout = setTimeout(() => socket.close(1008, 'Login timeout'), 10000);
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 30000);
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => {});
    socket.on('message', raw => {
      let input: unknown;
      try { input = JSON.parse(raw.toString()); } catch { input = null; }
      const parsed = ClientPacket.safeParse(input);
      if (!parsed.success) { send(socket, { version: 1, type: 'error', payload: { code: 'INVALID_PACKET', message: '消息格式不正确' } }); return; }
      const packet = parsed.data;
      const fail = (code: string, message: string) => send(socket, { version: 1, type: 'error', requestId: packet.requestId, payload: { code, message } });
      if (packet.type === 'auth.login') {
        if (user) return fail('ALREADY_AUTHENTICATED', '当前连接已登录');
        if (options.users[packet.payload.username] !== packet.payload.password) {
          fail('AUTH_FAILED', '用户名或密码错误，请修改配置后重新加载');
          socket.close(1008, 'Authentication failed'); return;
        }
        user = packet.payload.username;
        clearTimeout(loginTimeout);
        const previous = sessions.get(user);
        sessions.set(user, socket);
        if (previous && previous !== socket) {
          calls.disconnect('replaced');
          remotes.disconnect('replaced');
          send(previous, { version: 1, type: 'session.replaced', payload: {} });
          previous.close(4001, 'Session replaced');
        }
        send(socket, { version: 1, type: 'auth.ok', requestId: packet.requestId, payload: { user, ice: issueIce(turn, user) } });
        presence(); return;
      }
      if (!user || sessions.get(user) !== socket) return fail('NOT_AUTHENTICATED', '需要重新登录');
      if (packet.type === 'rtc.config') {
        send(socket, { version: 1, type: 'rtc.config', requestId: packet.requestId, payload: issueIce(turn, user) }); return;
      }
      if (packet.type === 'rtc.signal') {
        const peer = sessions.get(otherUser(user));
        if (!peer || peer.readyState !== 1 || peer.bufferedAmount > 1024 * 1024) {
          calls.disconnect('disconnected'); return fail('PEER_UNAVAILABLE', '对端连接不可用');
        }
        try {
          const signal = calls.signal(user, packet.payload);
          send(peer, { version: 1, type: 'rtc.signal', payload: { sender: user, signal } });
          send(socket, { version: 1, type: 'rtc.ack', requestId: packet.requestId, payload: { callId: signal.callId, generation: signal.generation } });
        } catch { fail('INVALID_RTC_STATE', '协商顺序、角色、通话或候选数量不符合要求'); }
        return;
      }
      if (packet.type === 'remote.signal') {
        const peer = sessions.get(otherUser(user));
        if (!peer || peer.readyState !== 1 || peer.bufferedAmount > 1024 * 1024) { remotes.disconnect('disconnected'); return fail('PEER_UNAVAILABLE', '对端连接不可用'); }
        try {
          const signal = remotes.signal(user, packet.payload);
          send(peer, { version: 1, type: 'remote.signal', payload: { sender: user, signal } });
          send(socket, { version: 1, type: 'remote.ack', requestId: packet.requestId, payload: { sessionId: signal.sessionId, generation: signal.generation } });
        } catch { fail('INVALID_REMOTE_STATE', '远程桌面协商顺序、角色或候选数量不符合要求'); }
        return;
      }
      if (packet.type === 'call.invite' || packet.type === 'call.accept' || packet.type === 'call.end' || packet.type === 'call.sync' || packet.type === 'call.ready') {
        try {
          const call = packet.type === 'call.invite' ? calls.invite(user, sessions.get(otherUser(user))?.readyState === 1)
            : packet.type === 'call.accept' ? calls.accept(user, packet.payload.callId)
            : packet.type === 'call.ready' ? calls.ready(user, packet.payload.callId)
            : packet.type === 'call.end' ? calls.end(user, packet.payload.callId) : calls.snapshot();
          send(socket, { version: 1, type: 'call.state', requestId: packet.requestId, payload: { call } });
        } catch (error) { fail(error instanceof Error ? error.message : 'CALL_ERROR', '通话请求无效或对方不在线'); }
        return;
      }
      if (packet.type === 'remote.invite' || packet.type === 'remote.accept' || packet.type === 'remote.permissions' || packet.type === 'remote.end' || packet.type === 'remote.sync' || packet.type === 'remote.ready') {
        try {
          const session = packet.type === 'remote.invite' ? remotes.invite(user, sessions.get(otherUser(user))?.readyState === 1)
            : packet.type === 'remote.accept' ? remotes.accept(user, packet.payload.sessionId, packet.payload.permissions)
            : packet.type === 'remote.permissions' ? remotes.permissions(user, packet.payload.sessionId, packet.payload.permissions)
            : packet.type === 'remote.ready' ? remotes.readyUser(user, packet.payload.sessionId)
            : packet.type === 'remote.end' ? remotes.end(user, packet.payload.sessionId) : remotes.snapshot();
          send(socket, { version: 1, type: 'remote.state', requestId: packet.requestId, payload: { session } });
        } catch (error) { fail(error instanceof Error ? error.message : 'REMOTE_ERROR', '远程桌面请求无效或对方不在线'); }
        return;
      }
      try {
        if (packet.type === 'message.sync') {
          send(socket, { version: 1, type: 'message.page', requestId: packet.requestId, payload: store.page(packet.payload.after) });
        } else {
          const result = store.save(user, packet.payload.clientId, packet.payload.text);
          send(socket, { version: 1, type: 'message.stored', requestId: packet.requestId, payload: result.message });
          if (result.inserted) for (const peer of sessions.values()) if (peer !== socket) send(peer, { version: 1, type: 'message.stored', payload: result.message });
        }
      } catch { fail('STORAGE_ERROR', '消息暂未保存，请稍后重试'); }
    });
    socket.on('close', () => {
      clearTimeout(loginTimeout); clearInterval(heartbeat); sockets.delete(socket);
      if (user && sessions.get(user) === socket) { sessions.delete(user); calls.disconnect('disconnected'); remotes.disconnect('disconnected'); presence(); }
    });
  });
  app.addHook('preClose', async () => { calls.disconnect('server-shutdown'); remotes.disconnect('server-shutdown'); for (const socket of sockets) socket.terminate(); });
  app.addHook('onClose', async () => {
    store.close();
    if (temporaryAttachments) rmSync(attachmentsDir, { recursive: true, force: true });
  });
  return app;
}
