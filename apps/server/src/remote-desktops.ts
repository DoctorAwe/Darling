import { randomUUID } from 'node:crypto';
import { otherUser, RemoteSignal, type RemoteSessionState, type User } from '../../../packages/protocol/src/index';

export class RemoteDesktops {
  private current: RemoteSessionState | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private offer = false;
  private answer = false;
  private ready = new Set<User>();
  private candidates: Record<User, number> = { dva: 0, mercy: 0 };
  constructor(private publish: (session: RemoteSessionState) => void, private timeoutMs = 30000) {}
  snapshot() { return this.current ? structuredClone(this.current) : null; }
  invite(user: User, peerOnline: boolean) {
    if (!peerOnline) throw new Error('PEER_OFFLINE');
    if (this.current) return this.snapshot()!;
    this.current = { sessionId: randomUUID(), controller: user, controlled: otherUser(user), phase: 'ringing', permissions: { control: false, audio: false }, deadline: Date.now() + this.timeoutMs };
    this.arm(); this.publish(this.snapshot()!); return this.snapshot()!;
  }
  accept(user: User, sessionId: string, permissions: RemoteSessionState['permissions']) {
    const session = this.require(sessionId);
    if (user !== session.controlled) throw new Error('NOT_CONTROLLED');
    if (session.phase === 'connecting' || session.phase === 'active') return this.snapshot()!;
    session.permissions = { ...permissions }; session.phase = 'connecting'; session.deadline = Date.now() + this.timeoutMs;
    this.arm(); this.publish(this.snapshot()!); return this.snapshot()!;
  }
  permissions(user: User, sessionId: string, permissions: RemoteSessionState['permissions']) {
    const session = this.require(sessionId);
    if (user !== session.controlled || !['connecting', 'active'].includes(session.phase)) throw new Error('NOT_CONTROLLED');
    session.permissions = { ...permissions }; this.publish(this.snapshot()!); return this.snapshot()!;
  }
  end(user: User, sessionId: string) {
    const session = this.require(sessionId);
    return this.finish(session.phase === 'ringing' ? (user === session.controller ? 'cancelled' : 'rejected') : 'hangup')!;
  }
  signal(user: User, input: unknown) {
    const signal = RemoteSignal.parse(input); const session = this.require(signal.sessionId);
    if (!['connecting', 'active'].includes(session.phase)) throw new Error('REMOTE_NOT_ACCEPTED');
    if (signal.kind === 'offer') { if (user !== session.controller || this.offer) throw new Error('UNEXPECTED_OFFER'); this.offer = true; }
    else if (signal.kind === 'answer') { if (user !== session.controlled || !this.offer || this.answer) throw new Error('UNEXPECTED_ANSWER'); this.answer = true; }
    else { if (!(user === session.controller ? this.offer : this.answer)) throw new Error('DESCRIPTION_REQUIRED'); if (this.candidates[user]++ >= 128) throw new Error('ICE_LIMIT'); }
    return signal;
  }
  readyUser(user: User, sessionId: string) {
    const session = this.require(sessionId);
    if (session.phase === 'active') return this.snapshot()!;
    if (session.phase !== 'connecting' || !this.offer || !this.answer) throw new Error('REMOTE_NOT_NEGOTIATED');
    this.ready.add(user);
    if (this.ready.size === 2) { session.phase = 'active'; session.deadline = 0; session.startedAt = Date.now(); clearTimeout(this.timer); this.publish(this.snapshot()!); }
    return this.snapshot()!;
  }
  disconnect(reason: RemoteSessionState['reason']) { this.finish(reason); }
  private require(id: string) { if (!this.current || this.current.sessionId !== id) throw new Error('STALE_REMOTE'); return this.current; }
  private arm() { clearTimeout(this.timer); this.timer = setTimeout(() => this.finish('timeout'), this.timeoutMs); this.timer.unref(); }
  private finish(reason: RemoteSessionState['reason']) {
    clearTimeout(this.timer); if (!this.current) return null;
    const ended: RemoteSessionState = { ...this.current, phase: 'ended', reason, deadline: Date.now() };
    this.current = null; this.offer = false; this.answer = false; this.ready.clear(); this.candidates = { dva: 0, mercy: 0 }; this.publish(ended); return ended;
  }
}
