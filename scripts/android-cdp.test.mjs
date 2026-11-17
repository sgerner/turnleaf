import { describe, expect, it } from 'vitest';
import { createCdpClient } from './android-cdp.mjs';

class FakeWebSocket extends EventTarget {
  sent = [];

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  reply(message) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: JSON.stringify(message) });
    this.dispatchEvent(event);
  }

  close() {
    this.dispatchEvent(new Event('close'));
  }
}

describe('Android WebView CDP client', () => {
  it('matches replies to concurrent evaluations by request id', async () => {
    const socket = new FakeWebSocket();
    const client = createCdpClient(socket);
    const first = client.evaluate('first');
    const second = client.evaluate('second');

    socket.reply({ id: socket.sent[1].id, result: { result: { value: 'second' } } });
    socket.reply({ id: socket.sent[0].id, result: { result: { value: 'first' } } });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    client.close();
  });

  it('ignores a late reply after a timed-out evaluation', async () => {
    const socket = new FakeWebSocket();
    const client = createCdpClient(socket, { timeoutMs: 5 });
    await expect(client.evaluate('slow')).rejects.toThrow('Timed out');

    const next = client.evaluate('next');
    socket.reply({ id: socket.sent[0].id, result: { result: { value: 'stale' } } });
    socket.reply({ id: socket.sent[1].id, result: { result: { value: 'current' } } });

    await expect(next).resolves.toBe('current');
    client.close();
  });

  it('rejects evaluations when the debugger socket closes', async () => {
    const socket = new FakeWebSocket();
    const client = createCdpClient(socket);
    const evaluation = client.evaluate('pending');
    socket.close();

    await expect(evaluation).rejects.toThrow('connection closed');
  });
});
