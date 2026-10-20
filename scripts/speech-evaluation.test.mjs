import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Generated noise validates file plumbing, NEVER a real-speech quality result.
test('offline WAV CLI accepts valid fixtures and rejects invalid inputs', { timeout: 60000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'darling-wav-test-'));
  const executable = resolve('native/media-engine/build/aec3-evaluation/Release/aec3-evaluation.exe');
  const wav = (seconds, seed, amplitude = .15) => {
    const count = seconds * 48000;
    const bytes = Buffer.alloc(44 + count * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < count; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      bytes.writeInt16LE(Math.round(((seed >>> 0) / 4294967295 * 2 - 1) * amplitude * 32767), 44 + i * 2);
    }
    return bytes;
  };
  const save = (name, bytes) => { const path = join(directory, name); writeFileSync(path, bytes); return path; };
  const run = (far, near) => {
    const result = spawnSync(executable, ['--speech-wav', far, near], { encoding: 'utf8', timeout: 40000, windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  try {
    const far = save('far.wav', wav(40, 123));
    const near = save('near.wav', wav(40, 456));
    const valid = run(far, near);
    assert.ok([0, 11].includes(valid.status), valid.stderr);
    assert.match(valid.stdout, /WAV_RESULT passed=[01]/);
    assert.match(valid.stdout, /normalization=false resampling=false profile=default/);
    const paths = spawnSync(executable, ['--speech-paths', far, near], { encoding: 'utf8', timeout: 40000, windowsHide: true });
    assert.ifError(paths.error);
    assert.ok([0, 11].includes(paths.status), paths.stderr);
    assert.equal((paths.stdout.match(/WAV_PATH mode=/g) || []).length, 3);
    assert.equal((paths.stdout.match(/WAV_WINDOW /g) || []).length, 12);
    assert.equal((paths.stdout.match(/WAV_STATE /g) || []).length, 120);
    const stateLines = paths.stdout.split('\n').filter(line => line.startsWith('WAV_STATE '));
    const counter = (line, name) => Number(line.match(new RegExp('(?:^| )' + name + '=(\\d+)'))?.[1]);
    assert.ok(stateLines.some(line => counter(line, 'eligible') > 0), 'Loud synthetic fixture must exercise updates');
    assert.ok(stateLines.some(line => counter(line, 'filters_updated') > 0));
    for (const line of stateLines) {
      assert.ok(counter(line, 'match_samples') > 0);
      assert.equal(counter(line, 'match_saturated'), 0);
      assert.equal(counter(line, 'low_energy') + counter(line, 'eligible'), counter(line, 'match_samples'));
      assert.ok(counter(line, 'reliable_updated') <= counter(line, 'filters_updated'));
      assert.ok(counter(line, 'filters_updated') <= counter(line, 'filters_checked'));
    }
    assert.equal((paths.stdout.match(/WAV_RESULT /g) || []).length, 3);
    assert.equal(paths.stdout.match(/double_talk_correlation=.*$/m)[0], valid.stdout.match(/double_talk_correlation=.*$/m)[0]);
    assert.equal(run(far, far).status, 65);
    assert.equal(run(far, save('short.wav', wav(1, 789))).status, 65);
    assert.equal(run(far, save('silent.wav', wav(40, 789, 0))).status, 65);
    assert.equal(run(far, join(directory, 'missing.wav')).status, 65);
    const wrongRate = wav(1, 789); wrongRate.writeUInt32LE(16000, 24);
    assert.equal(run(far, save('wrong-rate.wav', wrongRate)).status, 65);
    const hotFar = save('hot-far.wav', wav(40, 123, .99));
    const hotNear = save('hot-near.wav', wav(40, 456, .99));
    assert.equal(run(hotFar, hotNear).status, 65);
    const quietFar = save('gain-far.wav', wav(40, 123, .02));
    const quietNear = save('gain-near.wav', wav(40, 456, .02));
    const gained = spawnSync(executable, ['--speech-gain-12', quietFar, quietNear], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.ifError(gained.error);
    assert.ok([0,11].includes(gained.status), gained.stderr);
    assert.match(gained.stdout, /WAV_GAIN db=12 .*scope=both-inputs diagnostic=1/);
    assert.equal((gained.stdout.match(/WAV_RESULT /g) || []).length, 3);
    const clippedGain = spawnSync(executable, ['--speech-gain-24', far, near], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.ifError(clippedGain.error);
    assert.equal(clippedGain.status, 65);
    assert.match(clippedGain.stderr, /would clip input/);
    assert.doesNotMatch(clippedGain.stdout, /WAV_RESULT/);
    const lowExcitation = spawnSync(executable, ['--speech-low-excitation', far, near], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.ifError(lowExcitation.error);
    assert.ok([0,11].includes(lowExcitation.status), lowExcitation.stderr);
    assert.match(lowExcitation.stdout, /WAV_GAIN db=0 /);
    assert.equal((lowExcitation.stdout.match(/scenario_profile=diagnostic-low-excitation/g) || []).length, 3);
    assert.equal((lowExcitation.stdout.match(/WAV_RESULT /g) || []).length, 3);
    const negative = spawnSync(executable, ['--speech-negative', far, near], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.ifError(negative.error);
    assert.ok([0,11].includes(negative.status), negative.stderr);
    const negatives=negative.stdout.split('\n').filter(line=>line.startsWith('NEGATIVE_RESULT '));
    assert.equal(negatives.length,8);
    assert.equal(negatives.filter(line=>line.includes('case=near-only passed=1')).length,2);
    assert.equal(negatives.filter(line=>line.includes('case=silent-mic passed=1')).length,2);
    assert.ok(negatives.filter(line=>line.includes('case=silent-mic')).every(line=>!line.includes('correlation=')));
    assert.equal(negative.status, negatives.every(line=>line.includes('passed=1')) ? 0 : 11);
    assert.equal((negative.stdout.match(/NEGATIVE_STATE /g) || []).length, 8);
    const maskNegative = spawnSync(executable, ['--speech-negative-mask', far, near], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    assert.ifError(maskNegative.error);
    assert.ok([0,11].includes(maskNegative.status), maskNegative.stderr);
    assert.equal((maskNegative.stdout.match(/NEGATIVE_RESULT profile=diagnostic-nearend-mask /g) || []).length,4);
    assert.deepEqual(maskNegative.stdout.split('\n').filter(line=>line.startsWith('NEGATIVE_RESULT profile=default ')), negatives.filter(line=>line.startsWith('NEGATIVE_RESULT profile=default ')));
    for (const line of maskNegative.stdout.split('\n').filter(line=>line.startsWith('NEGATIVE_STATE '))) {
      assert.match(line, /blocks=1750 /);
      const blocks=1750;
      for (const name of ['usable','dominant']) assert.ok(Number(line.match(new RegExp(name+'=(\\d+)'))[1])<=blocks);
    }
    for (const [input, expected] of [[near, valid.status], [far, 65]]) {
      const wrapped = spawnSync(process.env.DARLING_TEST_PWSH || 'powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/evaluate-speech.ps1'),
        '-FarWav', far, '-NearWav', input, '-SourceNote', 'Generated noise, plumbing test only; not speech.'
      ], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
      assert.ifError(wrapped.error);
      assert.equal(wrapped.status, expected, wrapped.stdout + wrapped.stderr);
      const match = wrapped.stdout.match(/Report: (.+)\r?\n/);
      assert.ok(match, wrapped.stdout + wrapped.stderr);
      const report = JSON.parse(readFileSync(match[1].trim(), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(report.exitCode, expected);
      assert.equal(report.inputChangedDuringRun, false);
      assert.equal(report.contentVerifiedAsSpeech, false);
      assert.match(report.inputs[0].sha256, /^[A-F0-9]{64}$/);
    }
  } finally {
    rmSync(directory, { recursive: true }); // Exact directory returned by mkdtemp, no user data.
  }
});
