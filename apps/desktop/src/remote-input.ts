import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RemoteInputEvent, type RemoteInputEvent as InputEvent } from '../../../packages/protocol/src/index';

export class RemoteInputGate {
  private windowStarted = 0;
  private count = 0;
  constructor(private readonly limit = 600) {}
  parse(value: unknown, now = Date.now()): InputEvent {
    if (now - this.windowStarted >= 1000) { this.windowStarted = now; this.count = 0; }
    if (++this.count > this.limit) throw new Error('远程输入频率过高');
    return RemoteInputEvent.parse(value);
  }
}

export class RemoteInputHost {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private chain = Promise.resolve();
  constructor(private readonly executable: string) {}
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timeout = setTimeout(() => reject(new Error('远程输入辅助进程启动超时')), 3000);
      lines.once('line', line => {
        clearTimeout(timeout);
        try { const packet = JSON.parse(line); if (packet.type !== 'input.ready') throw new Error('握手失败'); resolve(); }
        catch (error) { reject(error); }
      });
      child.once('error', reject);
      child.once('exit', () => { this.child = undefined; this.ready = undefined; });
      child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), type: 'input.hello', payload: {} }) + '\n');
    });
    return this.ready;
  }
  send(event: InputEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.start();
      if (!this.child?.stdin.writable) throw new Error('远程输入辅助进程不可用');
      this.child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), type: 'input.event', payload: event }) + '\n');
    });
    return this.chain;
  }
  async stop() {
    const child = this.child; this.child = undefined; this.ready = undefined;
    if (!child) return;
    if (child.stdin.writable) {
      child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), type: 'input.event', payload: { type: 'release' } }) + '\n');
      child.stdin.end(JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), type: 'input.shutdown', payload: {} }) + '\n');
    }
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}
