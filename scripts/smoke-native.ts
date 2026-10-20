import { resolve } from 'node:path';
import { MediaHost } from '../apps/desktop/src/media';
const engine = resolve(process.env.DARLING_MEDIA_ENGINE ?? 'apps/desktop/dist/native/darling-media.exe');
const host = new MediaHost(engine);
try {
  await host.start();
  if (host.state.status !== 'ready') throw new Error(host.state.detail);
  if (!host.state.capabilities.devices) throw new Error('Device enumeration capability missing');
  console.log(JSON.stringify({
    engineVersion: host.state.engineVersion,
    capabilities: host.state.capabilities,
    inputs: host.state.devices.filter(device => device.direction === 'input').length,
    outputs: host.state.devices.filter(device => device.direction === 'output').length,
    note: 'Device inspection only; microphone capture was not started.',
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Native smoke test failed');
  process.exitCode = 1;
} finally { await host.stop(); }
