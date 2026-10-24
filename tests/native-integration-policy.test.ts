import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Windows call stream explicitly refuses to duck other applications', () => {
  const patch = readFileSync('native/rtc-smoke/target.patch', 'utf8');
  assert.match(patch, /IAudioClientDuckingControl/);
  assert.match(patch, /AUDIO_DUCKING_OPTIONS_DO_NOT_DUCK_OTHER_STREAMS/);
});

test('native remote video child is opaque and raised above Electron content', () => {
  const renderer = readFileSync('native/rtc-smoke/desktop_video_renderer.cc', 'utf8');
  assert.doesNotMatch(renderer, /CreateWindowExW\([\s\S]{0,100}WS_EX_TRANSPARENT/);
  assert.match(renderer, /SetWindowPos\(window, HWND_TOP/);
  assert.match(renderer, /RDW_UPDATENOW/);
});
