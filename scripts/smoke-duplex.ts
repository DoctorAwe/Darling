// Explicit hardware diagnostic: captures briefly and emits a low-amplitude one-second tone.
import { resolve } from 'node:path';
import { MediaHost } from '../apps/desktop/src/media';
const experimental = process.argv.includes('--aec3');
const host = new MediaHost(resolve(experimental ? 'native/media-engine/build/aec3-evaluation/Release/darling-media-aec3.exe' : 'apps/desktop/dist/native/darling-media.exe'));
try {
  await host.start();
  if (host.state.capabilities.aec !== experimental) throw new Error('Unexpected AEC capability');
  for (let round = 0; round < (experimental ? 2 : 1); ++round) {
  await host.startCapture('default', process.argv.includes('--aec3'));
  if (!host.state.capture?.running) throw new Error(host.state.detail);
  await host.startPlayback('default');
  if (!host.state.playback?.running) throw new Error(host.state.detail);
  for (let i = 0; i < 40 && host.state.playback?.running; ++i) await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise(resolve => setTimeout(resolve, 200));
  const capture = structuredClone(host.state.capture), playback = structuredClone(host.state.playback);
  if (playback?.reason !== 'complete' || playback.frames !== 48000) throw new Error('Playback did not drain exactly one second');
  if (!capture?.running || !capture.processing || capture.processing.captureBlocks === 0 || capture.processing.referenceBlocks === 0) throw new Error(capture?.error || 'Capture did not consume render reference blocks');
  if (capture.processing.mode !== (experimental ? 'aec3-experimental' : 'bypass')) throw new Error('Unexpected processing mode');
  if (experimental && (capture.processing.referenceBlocks !== 100 || capture.processing.droppedReferences !== 0 || capture.processing.staleReferences !== 0 || !Number.isFinite(capture.processing.processedRms))) throw new Error('AEC session counters or output meter invalid');
  if (capture.format?.sampleRate !== 48000 || capture.format.channels !== 1) throw new Error('Incorrect processing format');
  await host.stopPlayback(); await host.stopCapture();
  if (host.state.capture?.running || host.state.playback?.running) throw new Error('Duplex stop failed');
  console.log(JSON.stringify({ passed: true, round: round + 1, captureFormat: capture.format, processing: capture.processing, submittedFrames: playback.frames, referenceBlocks: playback.referenceBlocks, streamLatencyMs: playback.streamLatencyMs, stopped: true, note: experimental ? 'Experimental AEC routing only, NOT an acoustic quality measurement; no audio saved or transmitted.' : 'Bypass only, no AEC/NS, no audio saved or transmitted.' }, null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await host.stop(); }
