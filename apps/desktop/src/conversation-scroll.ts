export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
export type SavedScroll = { top: number; atBottom: boolean };

export class ConversationScrollMemory<Key extends string> {
  private positions = new Map<Key, SavedScroll>();
  constructor(private bottomThreshold = 48) {}
  save(key: Key, metrics: ScrollMetrics) {
    const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    this.positions.set(key, { top: Math.max(0, Math.min(metrics.scrollTop, maximum)), atBottom: maximum - metrics.scrollTop <= this.bottomThreshold });
  }
  saved(key: Key) { return this.positions.get(key); }
  target(key: Key, metrics: ScrollMetrics) {
    const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight); const saved = this.positions.get(key);
    return saved ? saved.atBottom ? maximum : Math.min(saved.top, maximum) : maximum;
  }
  followsBottom(key: Key) { return this.positions.get(key)?.atBottom ?? true; }
  updateAfterProgrammaticScroll(key: Key, top: number, metrics: ScrollMetrics) {
    const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    this.positions.set(key, { top, atBottom: maximum - top <= this.bottomThreshold });
  }
}
