import { useEffect } from 'react';
// Low-gain local notification only; never fed into the RTC stream.
export function useCallTones(mode: 'incoming' | 'outgoing' | null) {
  useEffect(() => {
    if (!mode) return;
    const context = new AudioContext();
    const play = () => {
      if (context.state === 'closed') return;
      const start = context.currentTime;
      const notes = mode === 'incoming' ? [[0, 660], [.22, 880], [.46, 660], [.68, 880]] : [[0, 440], [.25, 480]];
      for (const [offset, frequency] of notes) {
        const oscillator = context.createOscillator(); const gain = context.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(.035, start + offset + .025);
        gain.gain.linearRampToValueAtTime(0, start + offset + .19);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start + offset); oscillator.stop(start + offset + .2);
      }
    };
    void context.resume().then(() => { if (context.state !== 'closed') play(); }).catch(() => {});
    const timer = setInterval(play, mode === 'incoming' ? 2800 : 3500);
    return () => { clearInterval(timer); void context.close().catch(() => {}); };
  }, [mode]);
}
