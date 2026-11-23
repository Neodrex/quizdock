import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame } from '../game/game-client';
import { mockApi, renderApp } from '../test/harness';

/**
 * The host's own projection window (local auth, no socket yet) speaks as the host:
 * `useGameSession` connects with `connectHost` (a local name in `auth`), and no escape
 * hook below it may create a guest socket first (`connectPlayer`, no `auth`), which
 * would make the room's projection a window waiting for a pairing code.
 */
const { opened } = vi.hoisted(() => ({ opened: [] as Array<{ auth?: unknown }> }));

vi.mock('socket.io-client', () => ({
  io: (_url: string, opts: { auth?: unknown }) => {
    opened.push(opts);
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    return {
      connected: true,
      io: { on: () => {}, off: () => {} },
      on: (e: string, cb: (p: unknown) => void) => {
        if (!listeners.has(e)) listeners.set(e, new Set());
        listeners.get(e)!.add(cb);
      },
      once: () => {},
      off: () => {},
      disconnect: () => {},
      emit: (_e: string, _p: unknown, ack?: (r: unknown) => void) => {
        if (typeof ack === 'function') ack({ ok: true });
      },
    };
  },
}));

afterEach(() => {
  disconnectGame();
  opened.length = 0;
  localStorage.clear();
});

describe('ScreenView: the host’s own projection window', () => {
  it('connects as the host (connectHost), never as a guest (connectPlayer)', async () => {
    localStorage.setItem('live.localUser', 'Hôte');
    mockApi([]);
    renderApp('/session/482913/projection');
    await waitFor(() => expect(opened).toHaveLength(1));
    // Let any late effect try to take a socket of its own.
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toHaveLength(1);
    expect(opened[0].auth).toBeTypeOf('function');
  });
});
