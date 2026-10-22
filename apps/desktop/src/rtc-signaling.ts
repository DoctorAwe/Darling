import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RtcSignal, type CallState, type ClientPacket, type User } from '../../../packages/protocol/src/index';

// Main-process boundary only. An acknowledgement confirms relay, not media.
export class RtcSignaling extends EventEmitter {
  private scope?: { call: CallState; user: User };
  private pending = new Map<string, { callId: string; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private transmit: (packet: ClientPacket) => void, private timeoutMs = 10000) { super(); }
  bind(call: CallState | null | undefined, user: User | undefined, online: boolean) {
    const valid = online && user && (call?.phase === 'active' || (call?.phase === 'connecting' && call.deadline > Date.now())) &&
      (user === call.caller || user === call.callee);
    if (!valid) { this.clear(); return; }
    if (this.scope?.call.callId !== call.callId || this.scope.user !== user) this.clear();
    this.scope = { call: structuredClone(call), user };
  }
  clear() {
    const callId = this.scope?.call.callId;
    this.scope = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new Error('RTC call scope ended'));
    }
    this.pending.clear();
    if (callId) this.emit('closed', { callId, generation: 1 });
  }
  private accepts(signal: RtcSignal, sender: User) {
    const scope = this.scope;
    if (!scope || (scope.call.phase !== 'active' && scope.call.deadline <= Date.now()) || scope.call.callId !== signal.callId) return false;
    if (sender !== scope.call.caller && sender !== scope.call.callee) return false;
    return signal.kind === 'ice' || (signal.kind === 'offer' ? sender === scope.call.caller : sender === scope.call.callee);
  }
  send(value: unknown): Promise<void> {
    const parsed = RtcSignal.safeParse(value);
    if (!parsed.success || !this.scope || !this.accepts(parsed.data, this.scope.user))
      return Promise.reject(new Error('Invalid or stale RTC signal'));
    if (this.pending.size >= 16) return Promise.reject(new Error('RTC signaling queue full'));
    const signal = parsed.data;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new Error('RTC relay acknowledgement timed out'));
      }, this.timeoutMs);
      this.pending.set(requestId, { callId: signal.callId, resolve, reject, timer });
      try { this.transmit({ version: 1, type: 'rtc.signal', requestId, payload: signal }); }
      catch { this.reject(requestId, 'RTC transport unavailable'); }
    });
  }
  acknowledge(requestId: string, callId: string, generation: number) {
    const request = this.pending.get(requestId);
    if (!request || generation !== 1 || request.callId !== callId || this.scope?.call.callId !== callId) return;
    clearTimeout(request.timer); this.pending.delete(requestId); request.resolve();
  }
  reject(requestId: string, message: string): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    clearTimeout(request.timer); this.pending.delete(requestId); request.reject(new Error(message)); return true;
  }
  receive(sender: User, value: unknown) {
    const parsed = RtcSignal.safeParse(value);
    if (!parsed.success || sender === this.scope?.user || !this.accepts(parsed.data, sender)) return;
    this.emit('signal', structuredClone(parsed.data));
  }
}
