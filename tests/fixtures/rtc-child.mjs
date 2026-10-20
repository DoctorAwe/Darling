import { createInterface } from 'node:readline';
const mode = process.argv[2];
if (mode === 'hang-on-eof') setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (mode === 'silent') return;
  if (mode === 'garbage') { process.stdout.write('garbage\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(65537)); return; }
  if (mode === 'exit') { process.exit(0); }
  const payload = request.type === 'engine.hello'
    ? { engineVersion: 'fixture', negotiationOnly: true, rtc: false, capture: false, playback: false }
    : { callId: '00000000-0000-4000-8000-000000000099', generation: 1 };
  if (mode === 'hang-on-eof' && request.type !== 'engine.hello') Object.assign(payload, request.payload);
  if (mode === 'unexpected-synthetic' && request.type === 'engine.hello') {
    payload.negotiationOnly = false; payload.syntheticAudio = true;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: request.requestId, type: request.type === 'engine.hello' ? 'engine.ready' : 'rtc.ok', payload }) + '\n');
});
