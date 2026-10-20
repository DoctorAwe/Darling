import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioDevice } from '../packages/protocol/src/media';
import { describeOutputRoute } from '../apps/desktop/src/audio-route';
const make = (id: string, formFactor: string, extra = {}) => AudioDevice.parse({
  id, name: 'Bluetooth Headphones', direction: 'output', isDefault: false,
  isCommunicationsDefault: false, rawSupport: 'unknown', mixFormat: null, formFactor, ...extra,
});
test('route advice follows selected output metadata, never names or microphone type', () => {
  const devices = [make('mic', 'headset', { direction: 'input', isDefault: true }), make('speaker', 'speakers', { isDefault: true }), make('headset', 'headset')];
  assert.equal(describeOutputRoute(devices, 'default').kind, 'speakers');
  assert.equal(describeOutputRoute(devices, 'headset').kind, 'headphones');
  assert.equal(describeOutputRoute(devices, 'missing').kind, 'unknown');
  assert.equal(describeOutputRoute([make('usb', 'unknown')], 'usb').kind, 'unknown');
});
test('default changes and ambiguous connections are handled conservatively', () => {
  assert.equal(describeOutputRoute([make('h', 'headphones', { isDefault: true })], 'default').kind, 'headphones');
  for (const type of ['line-level', 'display', 'digital', 'handset', 'unknown']) {
    assert.equal(describeOutputRoute([make('o', type)], 'o').kind, 'unknown');
  }
  assert.equal(describeOutputRoute([], 'default').kind, 'unknown');
});
test('older engines without endpoint metadata remain compatible and unknown', () => {
  const { formFactor: _, ...legacy } = make('legacy', 'headphones');
  assert.equal(AudioDevice.parse(legacy).formFactor, 'unknown');
  assert.equal(AudioDevice.safeParse({ ...legacy, formFactor: 'invented' }).success, false);
});
