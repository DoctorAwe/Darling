import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import WebSocket from 'ws';
import { createServer } from '../apps/server/src/app';
import { MessageStore } from '../apps/server/src/store';
import { Session } from '../apps/desktop/src/session';
import type { ServerPacket, User } from '../packages/protocol/src/index';
import type { AiClient, AiInputMessage } from '../apps/server/src/ai/deepseek-client';

async function client(url: string) {
  const socket = new WebSocket(url);
  const inbox: ServerPacket[] = [];
  socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const send = (type: string, payload: unknown) => { const requestId = randomUUID(); socket.send(JSON.stringify({ version: 1, requestId, type, payload })); return requestId; };
  const wait = async (type: string, requestId?: string) => {
    for (let i = 0; i < 200; i++) {
      const index = inbox.findIndex(p => p.type === type && (!requestId || ('requestId' in p && p.requestId === requestId)));
      if (index >= 0) return inbox.splice(index, 1)[0] as any;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timed out: ${type}`);
  };
  const login = async (user: User, password = user + '-pass') => wait('auth.ok', send('auth.login', { username: user, password }));
  return { socket, send, wait, login };
}

function testPdf(text: string) {
  const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { output += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

test('real WebSocket: authentication, delivery, deduplication, sync and session replacement', async () => {
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const url = `ws://127.0.0.1:${address.port}/ws`;
  try {
    const bad = await client(url);
    const error = await bad.wait('error', bad.send('auth.login', { username: 'dva', password: 'wrong' }));
    assert.equal(error.payload.code, 'AUTH_FAILED');
    const a = await client(url); const b = await client(url);
    await a.login('dva'); await b.login('mercy');
    const payload = { clientId: randomUUID(), text: '你好，Mercy 🌸' };
    const stored = await a.wait('message.stored', a.send('message.send', payload));
    const delivered = await b.wait('message.stored');
    assert.equal(delivered.payload.id, stored.payload.id);
    assert.equal(stored.payload.sender, 'dva');
    const duplicate = await a.wait('message.stored', a.send('message.send', payload));
    assert.equal(duplicate.payload.seq, 1);
    const page = await b.wait('message.page', b.send('message.sync', { after: 0 }));
    assert.equal(page.payload.messages.length, 1);
    const replacement = await client(url); await replacement.login('dva');
    await a.wait('session.replaced');
    const reply = await replacement.wait('message.stored', replacement.send('message.send', { clientId: randomUUID(), text: '第二条' }));
    assert.equal(reply.payload.seq, 2);
    const tail = await b.wait('message.page', b.send('message.sync', { after: 1 }));
    assert.equal(tail.payload.messages.length, 1);
    assert.equal(tail.payload.messages[0].text, '第二条');
  } finally { await app.close(); }
});

test('authenticated attachment upload broadcasts, persists and downloads exact bytes', async () => {
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'darling-files-'));
  const app = await createServer({ database: ':memory:', attachmentsDir, users: { dva: 'dva-pass', mercy: 'mercy-pass' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/ws`;
  try {
    const a = await client(url); const b = await client(url);
    await a.login('dva'); await b.login('mercy');
    const clientId = randomUUID();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await fetch(`http://127.0.0.1:${port}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-darling-user': 'dva',
        'x-darling-password': 'dva-pass',
        'x-client-id': clientId,
        'x-file-name': encodeURIComponent('截图 01.png'),
        'x-mime-type': 'image/png',
      },
      body: bytes,
    });
    assert.equal(response.status, 201);
    const delivered = await b.wait('message.stored');
    assert.equal(delivered.payload.text, '');
    assert.deepEqual(delivered.payload.attachment, { id: delivered.payload.attachment.id, name: '截图 01.png', mime: 'image/png', size: bytes.length });
    const own = await a.wait('message.stored');
    assert.equal(own.payload.id, delivered.payload.id);

    const page = await b.wait('message.page', b.send('message.sync', { after: 0 }));
    assert.equal(page.payload.messages[0].attachment.name, '截图 01.png');
    const download = await fetch(`http://127.0.0.1:${port}/attachments/${delivered.payload.attachment.id}`, {
      headers: { 'x-darling-user': 'mercy', 'x-darling-password': 'mercy-pass' },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(`http://127.0.0.1:${port}/attachments/${delivered.payload.attachment.id}`)).status, 401);
  } finally {
    await app.close();
    rmSync(attachmentsDir, { recursive: true, force: true });
  }
});

test('AI group text chat is durable, deduplicated and isolated from direct messages', async () => {
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
  try {
    const dva = await client(url); const mercy = await client(url);
    await dva.login('dva'); await mercy.login('mercy');
    const clientId = randomUUID();
    const sent = await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId, text: '群聊第一条' }));
    const delivered = await mercy.wait('group.message.stored');
    assert.equal(sent.payload.sender, 'dva'); assert.equal(delivered.payload.id, sent.payload.id);
    const duplicate = await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId, text: '不得覆盖' }));
    assert.equal(duplicate.payload.id, sent.payload.id); assert.equal(duplicate.payload.text, '群聊第一条');
    const groupPage = await mercy.wait('group.message.page', mercy.send('group.sync', { groupId: 'dva-mercy-echo', after: 0 }));
    assert.equal(groupPage.payload.messages.length, 1); assert.equal(groupPage.payload.groupId, 'dva-mercy-echo');
    const directPage = await mercy.wait('message.page', mercy.send('message.sync', { after: 0 }));
    assert.equal(directPage.payload.messages.length, 0);
    await mercy.wait('message.stored', mercy.send('message.send', { clientId: randomUUID(), text: '私聊仍独立' }));
    const unchanged = await dva.wait('group.message.page', dva.send('group.sync', { groupId: 'dva-mercy-echo', after: 0 }));
    assert.equal(unchanged.payload.messages.length, 1);
  } finally { await app.close(); }
});

test('Echo streams replies, distinguishes both users and persists only the completed answer', async () => {
  const calls: AiInputMessage[][] = [];
  const fake: AiClient = { model: 'test-echo', async *stream(messages) { calls.push(messages); yield '收到，'; yield '两位。'; } };
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' }, aiClient: fake });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
  try {
    const dva = await client(url); const mercy = await client(url); await dva.login('dva'); await mercy.login('mercy');
    assert.equal((await dva.wait('group.ai.capability')).payload.available, true);
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: 'D.Va 的普通意见' }));
    await mercy.wait('group.message.stored', mercy.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: 'Mercy 的普通意见' }));
    const triggerId = mercy.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo 请区分我们' });
    await mercy.wait('group.message.stored', triggerId);
    const started = await mercy.wait('group.ai.started');
    assert.match((await mercy.wait('group.ai.delta')).payload.delta, /收到/);
    assert.match((await mercy.wait('group.ai.delta')).payload.delta, /两位/);
    const completed = await mercy.wait('group.ai.completed');
    assert.equal(completed.payload.requestId, started.payload.requestId);
    assert.equal(completed.payload.message.sender, 'echo'); assert.equal(completed.payload.message.text, '收到，两位。');
    assert.equal(calls.length, 1);
    const users = calls[0].filter(message => message.role === 'user');
    assert.deepEqual(users.map(message => message.name), ['dva', 'mercy', 'mercy']);
    const page = await dva.wait('group.message.page', dva.send('group.sync', { groupId: 'dva-mercy-echo', after: 0 }));
    assert.equal(page.payload.messages.length, 4); assert.equal(page.payload.messages.at(-1).sender, 'echo');
  } finally { await app.close(); }
});

test('stopping Echo aborts generation and never persists a partial answer', async () => {
  const fake: AiClient = { model: 'test-echo', async *stream(_messages, signal) {
    yield '不会落库的半截';
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } };
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' }, aiClient: fake });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
  try {
    const dva = await client(url); await dva.login('dva');
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo 停止测试' }));
    const started = await dva.wait('group.ai.started'); await dva.wait('group.ai.delta');
    dva.send('group.ai.cancel', { groupId: 'dva-mercy-echo', aiRequestId: started.payload.requestId });
    assert.equal((await dva.wait('group.ai.failed')).payload.error, '已停止生成');
    const page = await dva.wait('group.message.page', dva.send('group.sync', { groupId: 'dva-mercy-echo', after: 0 }));
    assert.equal(page.payload.messages.length, 1); assert.equal(page.payload.messages[0].sender, 'dva');
  } finally { await app.close(); }
});

test('group images upload independently and are reused as DeepSeek file context', async () => {
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'darling-group-files-')); let uploads = 0; const calls: AiInputMessage[][] = [];
  const fake: AiClient = {
    model: 'test-vision',
    async uploadImage(file) { uploads++; assert.equal(file.name, '群聊图片.png'); assert.equal(file.mime, 'image/png'); return { fileId: 'file-api-test-image', expiresAt: new Date(Date.now() + 3600000).toISOString() }; },
    async *stream(messages) { calls.push(messages); yield '看到了图片'; },
  };
  const app = await createServer({ database: ':memory:', attachmentsDir, users: { dva: 'dva-pass', mercy: 'mercy-pass' }, aiClient: fake });
  await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as { port: number }).port; const url = `ws://127.0.0.1:${port}/ws`;
  try {
    const dva = await client(url); const mercy = await client(url); await dva.login('dva'); await mercy.login('mercy');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await fetch(`http://127.0.0.1:${port}/groups/dva-mercy-echo/attachments`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-darling-user': 'dva', 'x-darling-password': 'dva-pass', 'x-client-id': randomUUID(), 'x-file-name': encodeURIComponent('群聊图片.png'), 'x-mime-type': 'image/png' }, body: bytes });
    assert.equal(response.status, 201); const attachmentMessage = await dva.wait('group.message.stored'); assert.equal(attachmentMessage.payload.attachment.name, '群聊图片.png');
    const download = await fetch(`http://127.0.0.1:${port}/groups/dva-mercy-echo/attachments/${attachmentMessage.payload.attachment.id}`, { headers: { 'x-darling-user': 'mercy', 'x-darling-password': 'mercy-pass' } });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo 图片里有什么？' })); await dva.wait('group.ai.completed');
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo 再看一次图片' })); await dva.wait('group.ai.completed');
    assert.equal(uploads, 1); assert.equal(calls.length, 2);
    const imageMessage = calls[0].find(message => Array.isArray(message.content));
    assert.deepEqual(imageMessage?.content, [{ type: 'text', text: '[图片：群聊图片.png]' }, { type: 'file', file_id: 'file-api-test-image' }]);
    const privatePage = await mercy.wait('message.page', mercy.send('message.sync', { after: 0 })); assert.equal(privatePage.payload.messages.length, 0);
  } finally { await app.close(); rmSync(attachmentsDir, { recursive: true, force: true }); }
});

test('text group attachments are indexed and relevant excerpts reach Echo', async () => {
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'darling-doc-files-')); const calls: AiInputMessage[][] = [];
  const fake: AiClient = { model: 'test-docs', async *stream(messages) { calls.push(messages); yield '文档回答'; } };
  const app = await createServer({ database: ':memory:', attachmentsDir, users: { dva: 'dva-pass', mercy: 'mercy-pass' }, aiClient: fake });
  await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as { port: number }).port; const url = `ws://127.0.0.1:${port}/ws`;
  try {
    const dva = await client(url); await dva.login('dva');
    const document = Buffer.from('# 音频方案\nPBFDAF 是备用回声消除路径。\nAEC3 是当前主线路径。', 'utf8');
    const response = await fetch(`http://127.0.0.1:${port}/groups/dva-mercy-echo/attachments`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-darling-user': 'dva', 'x-darling-password': 'dva-pass', 'x-client-id': randomUUID(), 'x-file-name': encodeURIComponent('音频方案.md'), 'x-mime-type': 'text/markdown' }, body: document });
    assert.equal(response.status, 201); await dva.wait('group.message.stored');
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo 文档里的 PBFDAF 是什么？' })); await dva.wait('group.ai.completed');
    assert.equal(calls.length, 1);
    const context = calls[0].find(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('检索摘录'));
    assert.match(String(context?.content), /音频方案\.md/); assert.match(String(context?.content), /PBFDAF 是备用回声消除路径/);
    const attachmentLabel = calls[0].find(message => message.role === 'user' && message.content === '[附件：音频方案.md]'); assert.ok(attachmentLabel);
  } finally { await app.close(); rmSync(attachmentsDir, { recursive: true, force: true }); }
});

test('PDF pages and DOCX paragraphs retain source locations for Echo', async () => {
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'darling-rich-doc-files-')); const calls: AiInputMessage[][] = [];
  const fake: AiClient = { model: 'test-rich-docs', async *stream(messages) { calls.push(messages); yield '文档回答'; } };
  const app = await createServer({ database: ':memory:', attachmentsDir, users: { dva: 'dva-pass', mercy: 'mercy-pass' }, aiClient: fake });
  await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as { port: number }).port; const url = `ws://127.0.0.1:${port}/ws`;
  try {
    const dva = await client(url); await dva.login('dva');
    const upload = async (name: string, mime: string, body: Buffer) => {
      const response = await fetch(`http://127.0.0.1:${port}/groups/dva-mercy-echo/attachments`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-darling-user': 'dva', 'x-darling-password': 'dva-pass', 'x-client-id': randomUUID(), 'x-file-name': encodeURIComponent(name), 'x-mime-type': mime }, body: body as unknown as BodyInit });
      assert.equal(response.status, 201); await dva.wait('group.message.stored');
    };
    await upload('network.pdf', 'application/pdf', testPdf('NVENC keeps remote desktop latency low.'));
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>AEC3 is the primary echo cancellation path.</w:t></w:r></w:p><w:p><w:r><w:t>RNNoise follows residual echo suppression.</w:t></w:r></w:p></w:body></w:document>');
    await upload('audio.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await zip.generateAsync({ type: 'nodebuffer' }));
    await dva.wait('group.message.stored', dva.send('group.message.send', { groupId: 'dva-mercy-echo', clientId: randomUUID(), text: '@Echo Compare NVENC latency and AEC3.' })); await dva.wait('group.ai.completed');
    const context = calls[0].find(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('检索摘录'));
    assert.match(String(context?.content), /network\.pdf[\s\S]*第 1 页[\s\S]*NVENC keeps remote desktop latency low/);
    assert.match(String(context?.content), /audio\.docx[\s\S]*第 1 段[\s\S]*AEC3 is the primary echo cancellation path/);
  } finally { await app.close(); rmSync(attachmentsDir, { recursive: true, force: true }); }
});

test('real WebSocket call signaling: auth, crossed invite, accept, replacement and stale call', async () => {
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
  try {
    const a = await client(url); const b = await client(url);
    assert.equal((await a.wait('error', a.send('call.invite', {}))).payload.code, 'NOT_AUTHENTICATED');
    await a.login('dva');
    assert.equal((await a.wait('error', a.send('call.invite', {}))).payload.code, 'PEER_OFFLINE');
    await b.login('mercy');
    const first = (await a.wait('call.state', a.send('call.invite', {}))).payload.call;
    assert.equal(first.phase, 'ringing');
    const crossed = (await b.wait('call.state', b.send('call.invite', {}))).payload.call;
    assert.equal(crossed.callId, first.callId);
    assert.equal((await a.wait('error', a.send('call.accept', { callId: first.callId }))).payload.code, 'NOT_CALLEE');
    const accepted = await b.wait('call.state', b.send('call.accept', { callId: first.callId }));
    assert.equal(accepted.payload.call.phase, 'connecting');
    const offer = { callId: first.callId, generation: 1, kind: 'offer', sdp: 'v=0\r\n' };
    assert.equal((await b.wait('error', b.send('rtc.signal', offer))).payload.code, 'INVALID_RTC_STATE');
    const ack = await a.wait('rtc.ack', a.send('rtc.signal', offer));
    assert.equal(ack.payload.callId, first.callId);
    const relayed = await b.wait('rtc.signal');
    assert.equal(relayed.payload.sender, 'dva'); assert.deepEqual(relayed.payload.signal, offer);
    const answer = { ...offer, kind: 'answer' };
    await b.wait('rtc.ack', b.send('rtc.signal', answer));
    assert.deepEqual((await a.wait('rtc.signal')).payload.signal, answer);
    const ice = { callId: first.callId, generation: 1, kind: 'ice', candidate: '', sdpMid: '0', sdpMLineIndex: 0 };
    await a.wait('rtc.ack', a.send('rtc.signal', ice));
    assert.deepEqual((await b.wait('rtc.signal')).payload.signal, ice);
    const replacement = await client(url); await replacement.login('dva');
    assert.equal((await replacement.wait('call.state', replacement.send('call.sync', {}))).payload.call, null);
    assert.equal((await b.wait('error', b.send('call.end', { callId: first.callId }))).payload.code, 'STALE_CALL');
    assert.equal((await b.wait('error', b.send('rtc.signal', answer))).payload.code, 'INVALID_RTC_STATE');
    const next = (await replacement.wait('call.state', replacement.send('call.invite', {}))).payload.call;
    assert.notEqual(next.callId, first.callId);
    // The replaced socket's late close must not tear down the new call.
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await b.wait('call.state', b.send('call.sync', {}))).payload.call.callId, next.callId);
    const closed = once(replacement.socket, 'close'); replacement.socket.close(); await closed;
    // Client close and the server's close callback are on independent event loops.
    let remaining: unknown = next;
    for (let i=0; i<30 && remaining; ++i) {
      remaining = (await b.wait('call.state', b.send('call.sync', {}))).payload.call;
      if (remaining) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(remaining, null);
  } finally { await app.close(); }
});

test('SQLite survives reopening and paginates without dropping messages', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'darling-db-')), 'chat.sqlite');
  let store = new MessageStore(file);
  const id = randomUUID(); store.save('dva', id, 'first');
  for (let i = 0; i < 104; i++) store.save('mercy', randomUUID(), String(i));
  store.close(); store = new MessageStore(file);
  try {
    assert.equal(store.save('dva', id, 'retry').message.text, 'first');
    const page = store.page(0); assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true);
    const tail = store.page(page.next); assert.equal(tail.messages.length, 5); assert.equal(tail.next, 105);
  } finally { store.close(); }
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('State timeout');
}

test('desktop receives invitations and rejects them while native RTC remains gated', async () => {
  const secret = 'cd'.repeat(32);
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' }, turn: { publicIp: '203.0.113.10', port: 3478, secret, ttlSeconds: 3600 } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
  const dir = mkdtempSync(join(tmpdir(), 'darling-call-session-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, server: { url }, auth: { username: 'dva', password: 'dva-pass' } }));
  const session = new Session(config, dir);
  try {
    const peer = await client(url);
    assert.equal((await peer.wait('error', peer.send('rtc.config', {}))).payload.code, 'NOT_AUTHENTICATED');
    const login = await peer.login('mercy');
    assert.match(login.payload.ice.iceServers[1].username, /:mercy$/);
    const refreshed = await peer.wait('rtc.config', peer.send('rtc.config', {}));
    assert.match(refreshed.payload.iceServers[1].username, /:mercy$/);
    assert.equal(JSON.stringify(refreshed).includes(secret), false);
    session.start(); await until(() => session.state.status === 'online' && !session.state.callPending);
    const ice = session.getIceConfig()!;
    assert.match(ice.iceServers[1].username!, /:dva$/);
    assert.equal(JSON.stringify(session.state).includes(ice.iceServers[1].credential!), false);
    assert.equal(session.getIceConfig(ice.expiresAt! - 59999), undefined);
    ice.iceServers.length = 0; assert.equal(session.getIceConfig()!.iceServers.length, 2);
    assert.equal(session.state.call, null);
    assert.equal(session.callAction('invite').ok, false);
    const invited = (await peer.wait('call.state', peer.send('call.invite', {}))).payload.call;
    await until(() => session.state.call?.callId === invited.callId);
    assert.equal(session.callAction('accept', invited.callId).ok, false);
    assert.equal(structuredClone(session.state).call?.phase, 'ringing');
    assert.equal(session.callAction('end', randomUUID()).ok, false);
    assert.equal(session.callAction('end', invited.callId).ok, true);
    assert.equal(session.callAction('end', invited.callId).ok, false);
    await until(() => session.state.call?.phase === 'ended' && !session.state.callPending);
    assert.equal(structuredClone(session.state).call?.reason, 'rejected');
    assert.equal(session.send('通话被拒绝后文字仍可用').ok, true);
    await until(() => session.state.messages.length === 1);
    session.stop(); assert.equal(session.state.call, null); assert.equal(session.state.callPending, false);
    assert.equal(session.getIceConfig(), undefined);
    session.start(); await until(() => session.state.status === 'online' && !session.state.callPending);
    assert.equal(session.state.call, null);
    assert.equal(session.state.mediaAvailable, false);
  } finally { session.stop(); await app.close(); }
});
test('desktop session automatically logs in and restores durable queued messages', async () => {
  const app = await createServer({ database: ':memory:', users: { dva: 'dva-pass', mercy: 'mercy-pass' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'darling-session-'));
  const config = join(dir, 'config.json');
  const url = `ws://127.0.0.1:${port}/ws`;
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, server: { url }, auth: { username: 'dva', password: 'dva-pass' } }));
  const session = new Session(config, dir);
  try {
    const queuedId = randomUUID();
    writeFileSync(join(dir, `outbox-${Buffer.from(url).toString('base64url')}-dva.json`), JSON.stringify([
      { clientId: queuedId, sender: 'dva', text: '离线待发', createdAt: new Date().toISOString() },
    ]));
    session.start(); await until(() => session.state.status === 'online');
    await until(() => session.state.messages.length === 1 && session.state.pending.length === 0);
    assert.equal(session.state.messages[0].clientId, queuedId);
    assert.equal(session.send('持久消息').ok, true);
    await until(() => session.state.messages.length === 2 && session.state.pending.length === 0);
    assert.equal(JSON.stringify(session.state).includes('dva-pass'), false);
    session.stop(); session.start();
    await until(() => session.state.messages.length === 2);
    assert.equal(session.state.messages[1].text, '持久消息');
  } finally { session.stop(); await app.close(); }
});
