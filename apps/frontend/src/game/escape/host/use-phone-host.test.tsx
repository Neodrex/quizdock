import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake socket that holds several listeners per event, as socket.io does.
const { fakeSocket, listeners, emitted, acks } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const acks = new Map<string, (payload: unknown) => unknown>();
  return {
    listeners,
    emitted,
    acks,
    fakeSocket: {
      connected: true,
      on: (e: string, cb: (p: unknown) => void) => {
        if (!listeners.has(e)) listeners.set(e, new Set());
        listeners.get(e)!.add(cb);
      },
      off: (e: string, cb: (p: unknown) => void) => {
        listeners.get(e)?.delete(cb);
        if (listeners.get(e)?.size === 0) listeners.delete(e);
      },
      emit: (e: string, payload: unknown, ack?: (r: unknown) => void) => {
        emitted.push({ event: e, payload });
        ack?.(acks.get(e)?.(payload) ?? { ok: true });
      },
    },
  };
});

vi.mock('../../game-client', async (orig) => ({
  ...(await orig<typeof import('../../game-client')>()),
  ensureGameSocket: () => Promise.resolve(fakeSocket),
}));

import { usePhoneHost } from './use-phone-host';

const PIN = '482913';
const flush = () => act(async () => {});
const fire = (event: string) => act(() => listeners.get(event)?.forEach((cb) => cb(undefined)));
const events = () => emitted.map((e) => e.event);

afterEach(() => {
  listeners.clear();
  emitted.length = 0;
  acks.clear();
  fakeSocket.connected = true;
});

describe('usePhoneHost', () => {
  it('off: sends nothing and listens to nothing', async () => {
    renderHook(() => usePhoneHost(PIN, false));
    await flush();
    expect(emitted).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it('takes the host role back on mount (a reload): host:attach, then escape:sync', async () => {
    renderHook(() => usePhoneHost(PIN, true));
    await flush();
    expect(emitted).toEqual([
      { event: 'host:attach', payload: { pin: PIN } },
      { event: 'escape:sync', payload: { pin: PIN } },
    ]);
  });

  it('takes it back after each reconnect, and lets the listener go on unmount', async () => {
    const { unmount } = renderHook(() => usePhoneHost(PIN, true));
    await flush();
    emitted.length = 0;
    fire('connect');
    await flush();
    expect(events()).toEqual(['host:attach', 'escape:sync']);
    unmount();
    expect(listeners.has('connect')).toBe(false);
    expect(listeners.has('escape:host')).toBe(false);
  });

  it('a refused attach syncs nothing', async () => {
    acks.set('host:attach', () => ({ ok: false, error: { code: 'game.not_host' } }));
    renderHook(() => usePhoneHost(PIN, true));
    await flush();
    expect(events()).toEqual(['host:attach']);
  });

  it('a socket still down waits for its connect', async () => {
    fakeSocket.connected = false;
    renderHook(() => usePhoneHost(PIN, true));
    await flush();
    expect(emitted).toEqual([]);
    fakeSocket.connected = true;
    fire('connect');
    await flush();
    expect(events()).toEqual(['host:attach', 'escape:sync']);
  });
});
