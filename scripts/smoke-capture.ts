// Explicit, short microphone diagnostic. Never called by the default test suite.
// No PCM leaves the native process and nothing is recorded or transmitted.
import { resolve } from 'node:path';
import { MediaHost } from '../apps/desktop/src/media';
const host = new MediaHost(resolve('apps/desktop/dist/native/darling-media.exe'));
try {
  await host.start();
  if (host.state.status !== 'ready' || !host.state.capabilities.capture) throw new Error('Native capture unavailable');
  const input = host.state.devices.find(device => device.direction === 'input');
  if (!input) throw new Error('No active microphone');
  await host.startCapture(input.id);
  if (!host.state.capture?.running) throw new Error(host.state.detail);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stats = structuredClone(host.state.capture);
  if (!stats?.running || stats.frames <= 0) throw new Error('No microphone frames captured');
  await host.stopCapture();
  if (host.state.capture?.running) throw new Error('Microphone did not stop');
  // Reopen via default routing to exercise resource release/device selection.
  await host.startCapture('default');
  if (!host.state.capture?.running) throw new Error('Capture restart failed');
  await new Promise(resolve => setTimeout(resolve, 500));
  await host.stopCapture();
  if (host.state.capture?.running) throw new Error('Restarted capture did not stop');
  console.log(JSON.stringify({ passed: true, frames: stats.frames, format: stats.format, discontinuities: stats.discontinuities, stopped: true, restartVerified: true, note: 'Microphone opened briefly; audio was not saved or sent.' }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await host.stop(); }
