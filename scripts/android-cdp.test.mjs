import { describe, expect, it, vi } from 'vitest';
import { createCdpClient, withoutCdpDebugger } from './android-cdp.mjs';

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

  it('detaches the active debugger session during window checks and reconnects afterward', async () => {
    const events = [];
    let active = {
      close: vi.fn(async () => {
        events.push('closed');
      }),
    };
    const reconnected = { close: vi.fn(async () => {}) };

    const value = await withoutCdpDebugger(
      {
        getClient: () => active,
        setClient: (next) => {
          active = next;
          events.push(next ? 'reconnected' : 'cleared');
        },
        connect: async () => {
          events.push('connecting');
          return reconnected;
        },
        settleDelayMs: 0,
      },
      async () => {
        expect(active).toBeUndefined();
        events.push('checked');
        return 'window-ok';
      },
    );

    expect(value).toBe('window-ok');
    expect(active).toBe(reconnected);
    expect(events).toEqual(['closed', 'cleared', 'checked', 'connecting', 'reconnected']);
  });

  it('keeps the debugger session cleared without reconnecting if the check throws', async () => {
    let active = { close: vi.fn(async () => {}) };
    const connect = vi.fn(async () => ({ close: vi.fn() }));

    await expect(
      withoutCdpDebugger(
        {
          getClient: () => active,
          setClient: (next) => {
            active = next;
          },
          connect,
          settleDelayMs: 0,
        },
        async () => {
          throw new Error('window check timed out');
        },
      ),
    ).rejects.toThrow('window check timed out');

    expect(active).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });
});
