// Idempotently installs Darling's disabled-by-default AEC3 diagnostic hook
// into the pinned local WebRTC checkout. It does not build or run audio.
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const rtc=resolve(root,'.local/webrtc/src');
const source=join(rtc,'modules/audio_processing/aec3/echo_remover.cc');
const destination=join(rtc,'modules/audio_processing/aec3/darling_diagnostics.h');
if(!existsSync(source)) throw new Error('Pinned WebRTC checkout missing');
copyFileSync(join(root,'native/rtc-smoke/aec3_diagnostics.h'),destination);
let text=readFileSync(source,'utf8');const nl=text.includes('\r\n')?'\r\n':'\n';
const include='#include "modules/audio_processing/aec3/darling_diagnostics.h"';
if(!text.includes(include)) {
  const anchor='#include "modules/audio_processing/aec3/delay_estimate.h"';
  if(!text.includes(anchor)) throw new Error('AEC3 include anchor changed');
  text=text.replace(anchor,anchor+nl+include);
}
const call=['    darling_aec3_diagnostics::Record(',
  '        suppression_gain_.IsDominantNearend(),',
  '        aec_state_.UsableLinearEstimate(), nearend_spectrum[0], R2[0],',
  '        R2_unbounded[0], G);'].join(nl);
if(!text.includes(call)) {
  const anchor=['    suppression_gain_.GetGain(nearend_spectrum, echo_spectrum, R2, R2_unbounded,',
    '                              cng_.NoiseSpectrum(), render_signal_analyzer_,',
    '                              aec_state_, x, clock_drift, &high_bands_gain, &G);'].join(nl);
  if(!text.includes(anchor)) throw new Error('AEC3 gain anchor changed');
  text=text.replace(anchor,anchor+nl+nl+call);
}
writeFileSync(source,text);
console.log('AEC3 diagnostic hook ready (disabled until explicitly enabled by offline test).');
