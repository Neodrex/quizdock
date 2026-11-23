import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame, savePlayerSession } from '../game/game-client';
import { renderApp } from '../test/harness';

/**
 * M7 Task 7.14: a room at its participant cap refuses `player:join` with the
 * upstream code `session.full`. The real phone page (`/join/$pin`) and the real
 * `joinSession`; only the socket.io transport is faked.
 */
interface FakeSocket {
  emitted: Array<{ event: string; payload: unknown }>;
  handlers: Map<string, (p: unknown) => void>;
  on: (e: string, cb: (p: unknown) => void) => void;
  once: () => void;
  off: (e: string) => void;
  emit: (e: string, payload: unknown, ack?: (r: unknown) => void) => void;
  disconnect: () => void;
  connected: boolean;
  io: { on: () => void; off: () => void };
}

const { sockets } = vi.hoisted(() => ({ sockets: [] as unknown[] }));

const makeSocket = (): FakeSocket => {
  const handlers = new Map<string, (p: unknown) => void>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emitted,
    handlers,
    io: { on: () => {}, off: () => {} },
    connected: true,
    on: (e, cb) => handlers.set(e, cb),
    once: () => {},
    off: (e) => handlers.delete(e),
    disconnect: () => {},
    emit: (e, payload, ack) => {
      emitted.push({ event: e, payload });
      if (typeof ack !== 'function') return;
      if (e === 'player:join') ack({ ok: false, error: { code: 'session.full' } });
      else ack({ ok: true });
    },
  };
};

vi.mock('socket.io-client', () => ({
  io: () => {
    const s = makeSocket();
    sockets.push(s);
    return s;
  },
}));

const joins = () =>
  (sockets as FakeSocket[]).flatMap((s) => s.emitted).filter((e) => e.event === 'player:join');

describe('a full session on the phone', () => {
  afterEach(() => {
    disconnectGame();
    sockets.length = 0;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('says so, keeps the nickname, and does not try again by itself', async () => {
    renderApp('/join/482913');
    const nickname = await screen.findByPlaceholderText('Votre pseudo');
    fireEvent.change(nickname, { target: { value: 'Zoé' } });
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre le salon/ }));
    expect(await screen.findByText('Ce salon est complet.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Votre pseudo')).toHaveValue('Zoé');
    expect(screen.getByRole('button', { name: /Rejoindre le salon/ })).toBeEnabled();
    await new Promise((r) => setTimeout(r, 300));
    expect(joins()).toHaveLength(1);
  });

  it('a phone that was in comes back through player:reconnect, never a join', async () => {
    savePlayerSession({ pin: '482913', sessionToken: 'tok', playerId: 'p1', nickname: 'Zoé' });
    renderApp('/join/482913');
    await waitFor(() =>
      expect(
        (sockets as FakeSocket[]).some((s) =>
          s.emitted.some((e) => e.event === 'player:reconnect'),
        ),
      ).toBe(true),
    );
    const reconnect = (sockets as FakeSocket[])
      .flatMap((s) => s.emitted)
      .find((e) => e.event === 'player:reconnect');
    expect(reconnect?.payload).toEqual({ sessionToken: 'tok' });
    expect(joins()).toHaveLength(0);
    expect(screen.queryByText('Ce salon est complet.')).toBeNull();
  });
});
