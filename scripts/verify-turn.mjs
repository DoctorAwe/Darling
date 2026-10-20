// Diagnostic TURN allocation only: no microphone, chat messages, or persisted credentials.
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import WebSocket from 'ws';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/verify-turn.mjs <client-config.json>');
const config = JSON.parse(readFileSync(path, 'utf8'));
const ice = await new Promise((resolve, reject) => {
  const ws = new WebSocket(config.server.url);
  const timer = setTimeout(() => { ws.terminate(); reject(new Error('Login timeout')); }, 10000);
  const finish = (error, value) => { clearTimeout(timer); ws.close(); error ? reject(error) : resolve(value); };
  ws.on('error', () => finish(new Error('Login connection failed')));
  ws.on('open', () => ws.send(JSON.stringify({version:1,type:'auth.login',requestId:randomUUID(),payload:config.auth})));
  ws.on('message', raw => {
    const packet = JSON.parse(raw);
    if (packet.type === 'auth.ok') finish(null, packet.payload.ice);
    if (packet.type === 'error') finish(new Error('Login rejected'));
  });
});
const relay = ice?.iceServers.find(s => s.username && s.credential);
if (!relay || ice.expiresAt <= Date.now() + 60000) throw new Error('No fresh TURN credentials');
const attr = (type, data) => {
  const b = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  b.writeUInt16BE(type); b.writeUInt16BE(data.length, 2); data.copy(b, 4); return b;
};
const number = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const attributes = packet => {
  const result = new Map();
  if (packet.length !== 20 + packet.readUInt16BE(2)) throw new Error('Invalid TURN length');
  for (let offset = 20; offset < packet.length;) {
    if (offset + 4 > packet.length) throw new Error('Truncated TURN attribute');
    const type = packet.readUInt16BE(offset), size = packet.readUInt16BE(offset + 2);
    if (offset + 4 + size > packet.length) throw new Error('Invalid TURN attribute');
    result.set(type, { data:packet.subarray(offset+4,offset+4+size), offset });
    offset += 4 + Math.ceil(size/4)*4;
  }
  return result;
};
for (const transport of ['udp', 'tcp']) {
  const uri = relay.urls.find(url => url.endsWith(`transport=${transport}`));
  const match = /^turn:(\d+\.\d+\.\d+\.\d+):(\d+)\?transport=(udp|tcp)$/.exec(uri ?? '');
  if (!match) throw new Error(`Missing IPv4 TURN ${transport} URI`);
  const host = match[1], port = Number(match[2]);
  const socket = transport === 'udp' ? createSocket('udp4') : createConnection({host,port});
  let buffered = Buffer.alloc(0), pending;
  const receive = packet => {
    if (!pending || packet.length < 20 || packet.readUInt32BE(4) !== 0x2112a442 || !packet.subarray(8,20).equals(pending.id)) return;
    const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(packet);
  };
  socket.on(transport === 'udp' ? 'message' : 'data', chunk => {
    if (transport === 'udp') return receive(chunk);
    buffered = Buffer.concat([buffered,chunk]);
    while (buffered.length >= 20 && buffered.length >= 20 + buffered.readUInt16BE(2)) {
      const size = 20 + buffered.readUInt16BE(2); receive(buffered.subarray(0,size)); buffered = buffered.subarray(size);
    }
  });
  socket.on('error', () => { if (pending) { clearTimeout(pending.timer); pending.reject(new Error(`${transport} transport failed`)); pending=undefined; } });
  const request = (type, fields, key) => new Promise((resolve,reject) => {
    const id = randomBytes(12), body = Buffer.concat(fields), header = Buffer.alloc(20);
    header.writeUInt16BE(type); header.writeUInt16BE(body.length + (key ? 24 : 0),2);
    header.writeUInt32BE(0x2112a442,4); id.copy(header,8);
    let packet = Buffer.concat([header,body]);
    if (key) packet = Buffer.concat([packet,attr(8,createHmac('sha1',key).update(packet).digest())]);
    const timer = setTimeout(() => { pending=undefined; reject(new Error(`${transport} TURN request timeout`)); },8000);
    pending = { id,resolve,reject,timer };
    if (transport === 'udp') socket.send(packet,port,host); else socket.write(packet);
  });
  try {
    const challenge = await request(3,[attr(0x19,Buffer.from([17,0,0,0]))]);
    const challengeAttrs=attributes(challenge), error=challengeAttrs.get(9)?.data;
    if (challenge.readUInt16BE(0)!==0x113 || !error || error[2]*100+error[3]!==401) throw new Error('Expected TURN authentication challenge');
    const realm=challengeAttrs.get(0x14)?.data, nonce=challengeAttrs.get(0x15)?.data;
    if (!realm || !nonce) throw new Error('Missing TURN realm/nonce');
    const key=createHash('md5').update(`${relay.username}:${realm.toString()}:${relay.credential}`).digest();
    const auth=[attr(6,Buffer.from(relay.username)),attr(0x14,realm),attr(0x15,nonce)];
    const check = (packet,type) => {
      if(packet.readUInt16BE(0)!==type) throw new Error(`${transport} TURN allocation/refresh rejected`);
      const fields=attributes(packet), integrity=fields.get(8);
      if(!integrity || integrity.data.length!==20) throw new Error('Missing TURN integrity');
      const signed=Buffer.from(packet.subarray(0,integrity.offset)); signed.writeUInt16BE(integrity.offset+24-20,2);
      if(!timingSafeEqual(createHmac('sha1',key).update(signed).digest(),integrity.data)) throw new Error('Invalid TURN integrity');
      return fields;
    };
    const allocation=check(await request(3,[attr(0x19,Buffer.from([17,0,0,0])),attr(0x0d,number(60)),...auth],key),0x103);
    const address=allocation.get(0x16)?.data;
    if(!address || address.length!==8 || address[1]!==1) throw new Error('No IPv4 relay allocation');
    const relayPort=address.readUInt16BE(2)^0x2112;
    const ip=number((address.readUInt32BE(4)^0x2112a442)>>>0).join('.');
    console.log(`PUBLIC_TURN_${transport.toUpperCase()}_AUTH_ALLOCATION_OK relay=${ip}:${relayPort}`);
    check(await request(4,[attr(0x0d,number(0)),...auth],key),0x104);
    console.log(`PUBLIC_TURN_${transport.toUpperCase()}_RELEASE_OK`);
  } finally {
    if(pending) clearTimeout(pending.timer);
    if(transport==='udp') socket.close(); else socket.destroy();
  }
}
