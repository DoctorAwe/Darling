import { randomUUID } from 'node:crypto';
import { otherUser, type CallState, type User, RtcSignal } from '../../../packages/protocol/src/index';

// Single two-person room. No media is opened or claimed connected by this controller.
export class Calls {
  private current: CallState | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private offer = false;
  private answer = false;
  private readyUsers = new Set<User>();
  private candidates: Record<User, number> = { dva: 0, mercy: 0 };
  constructor(private publish: (call: CallState) => void, private timeoutMs = 30000) {}
  snapshot() { return this.current ? { ...this.current } : null; }
  invite(user: User, peerOnline: boolean) {
    if (!peerOnline) throw new Error('PEER_OFFLINE');
    // Crossed invites converge to the original caller; accepting remains explicit.
    if (this.current) return this.snapshot()!;
    this.current = { callId: randomUUID(), caller: user, callee: otherUser(user), phase: 'ringing', deadline: Date.now() + this.timeoutMs };
    this.arm(); this.publish(this.snapshot()!); return this.snapshot()!;
  }
  accept(user: User, callId: string) {
    const call = this.require(callId);
    if (user !== call.callee) throw new Error('NOT_CALLEE');
    if (call.phase === 'connecting' || call.phase === 'active') return this.snapshot()!;
    call.phase = 'connecting'; call.deadline = Date.now() + this.timeoutMs;
    this.arm(); this.publish(this.snapshot()!); return this.snapshot()!;
  }
  end(user: User, callId: string) {
    const call = this.require(callId);
    return this.finish(call.phase === 'ringing' ? (user === call.caller ? 'cancelled' : 'rejected') : 'hangup')!;
  }
  ready(user: User, callId: string) {
    const call = this.require(callId);
    if (!['connecting', 'active'].includes(call.phase) || !this.offer || !this.answer) throw new Error('CALL_NOT_NEGOTIATED');
    this.readyUsers.add(user);
    if (call.phase === 'connecting' && this.readyUsers.size === 2) {
      call.phase = 'active'; call.deadline = Date.now() + 30 * 60 * 1000;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finish('timeout'), 30 * 60 * 1000); this.timer.unref();
      this.publish(this.snapshot()!);
    }
    return this.snapshot()!;
  }
  disconnect(reason: 'disconnected' | 'replaced' | 'server-shutdown') { this.finish(reason); }
  signal(user: User, input: RtcSignal) {
    const signal = RtcSignal.parse(input);
    const call = this.require(signal.callId);
    if (call.phase !== 'connecting' && call.phase !== 'active') throw new Error('CALL_NOT_ACCEPTED');
    if (signal.kind === 'offer') {
      if (user !== call.caller || this.offer) throw new Error('UNEXPECTED_OFFER');
      this.offer = true;
    } else if (signal.kind === 'answer') {
      if (user !== call.callee || !this.offer || this.answer) throw new Error('UNEXPECTED_ANSWER');
      this.answer = true;
    } else {
      // Sender must submit its local description first. No unbounded early-ICE queue.
      if (!(user === call.caller ? this.offer : this.answer)) throw new Error('DESCRIPTION_REQUIRED');
      if (this.candidates[user] >= 128) throw new Error('ICE_LIMIT');
      ++this.candidates[user];
    }
    return signal;
  }
  private require(id: string) {
    if (!this.current || this.current.callId !== id) throw new Error('STALE_CALL');
    return this.current;
  }
  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish('timeout'), this.timeoutMs);
    this.timer.unref();
  }
  private finish(reason: CallState['reason']) {
    clearTimeout(this.timer);
    if (!this.current) return null;
    const ended: CallState = { ...this.current, phase: 'ended', reason, deadline: Date.now() };
    this.current = null; this.offer = false; this.answer = false; this.candidates = { dva: 0, mercy: 0 };
    this.readyUsers.clear();
    this.publish(ended); return ended;
  }
}
