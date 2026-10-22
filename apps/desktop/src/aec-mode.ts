export type AecOverride = 'webrtc-aec3' | 'pbfdaf';

export function resolveAec3Enabled(voiceMode: boolean, requested?: string): boolean {
  if (requested && requested !== 'webrtc-aec3' && requested !== 'pbfdaf') throw new Error('Unknown AEC mode');
  if (requested === 'webrtc-aec3' && !voiceMode) throw new Error('AEC3 requires voice mode');
  return voiceMode && requested !== 'pbfdaf';
}
