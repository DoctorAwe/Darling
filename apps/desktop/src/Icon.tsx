export type IconName = 'phone' | 'mic' | 'speaker' | 'chat' | 'settings' | 'send';
const paths: Record<IconName, string> = {
  phone: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
  speaker: 'M3 9h4l5-4v14l-5-4H3V9ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  send: 'm5 12 14-7-7 14-1-7-6 0ZM11 12l8-7',
};
export function Icon({ name, muted = false }: { name: IconName; muted?: boolean }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/>{muted && <path d="M3 3l18 18"/>}</svg>;
}
