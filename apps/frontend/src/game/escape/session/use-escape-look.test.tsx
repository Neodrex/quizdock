import { BUILTIN_THEME_VALUES, GameState } from '@quiz-dock/contracts';
import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GameSocket } from '../../game-client';
import { LiveTheme } from '../../theme';
import { ACME_LOOK } from './look-fixtures';

// The page's socket, as `ensureGameSocket` hands it to every escape hook.
let current: GameSocket | null = null;
const taken: string[] = [];
vi.mock('../../game-client', async (orig) => ({
  ...(await orig<typeof import('../../game-client')>()),
  ensureGameSocket: (role: string, pin: string) => {
    taken.push(`${role} ${pin}`);
    return Promise.resolve(current);
  },
}));

import { NO_LOOK, useEscapeLook } from './use-escape-look';

function fakeSocket() {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const socket = {
    on: (e: string, cb: (p: unknown) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb);
    },
    off: (e: string, cb: (p: unknown) => void) => {
      listeners.get(e)?.delete(cb);
      if (listeners.get(e)?.size === 0) listeners.delete(e);
    },
  };
  const fire = (e: string, p: unknown) => act(() => listeners.get(e)?.forEach((cb) => cb(p)));
  current = socket as unknown as GameSocket;
  return { socket: current, listeners, fire };
}

/** The hook mounted, its socket taken (the promise settled). */
async function mounted<P>(hook: (p: P) => ReturnType<typeof useEscapeLook>, initialProps?: P) {
  const out = renderHook(hook, { initialProps: initialProps as P });
  await act(async () => {});
  return out;
}

describe('useEscapeLook', () => {
  it('takes the page’s socket itself: a look sent on the first sync is not missed', async () => {
    const { listeners } = fakeSocket();
    taken.length = 0;
    await mounted(() => useEscapeLook('123456', 'host', 1, GameState.Lobby));
    // Listening as soon as the socket is there, not once the page re-renders with it.
    expect(taken).toEqual(['host 123456']);
    expect(listeners.get('escape:look')?.size).toBe(1);
  });

  it('waits for the session’s attach: it never creates the socket itself', async () => {
    const { listeners } = fakeSocket();
    taken.length = 0;
    const { rerender } = await mounted(
      ({ seq }: { seq: number }) => useEscapeLook('123456', 'guest', seq, GameState.Lobby),
      { seq: 0 },
    );
    expect(taken).toEqual([]);
    expect(listeners.size).toBe(0);
    rerender({ seq: 1 });
    await act(async () => {});
    expect(taken).toEqual(['guest 123456']);
    expect(listeners.get('escape:look')?.size).toBe(1);
    // A re-attach keeps the one listener.
    rerender({ seq: 2 });
    await act(async () => {});
    expect(listeners.get('escape:look')?.size).toBe(1);
  });

  it('keeps the last look, and lets its listener go on unmount', async () => {
    const { listeners, fire } = fakeSocket();
    const { result, unmount } = await mounted(() =>
      useEscapeLook('123456', 'guest', 1, GameState.Escape),
    );
    expect(result.current).toEqual(NO_LOOK);
    fire('escape:look', ACME_LOOK);
    expect(result.current).toEqual(ACME_LOOK);
    fire('escape:look', NO_LOOK);
    expect(result.current).toEqual(NO_LOOK);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('a room switch (back to the lobby after a finale) drops it until a new look', async () => {
    const { fire } = fakeSocket();
    const { result, rerender } = await mounted(
      ({ s }: { s: string }) => useEscapeLook('123456', 'guest', 1, s),
      { s: GameState.Lobby as string },
    );
    fire('escape:look', ACME_LOOK);
    // The lobby it was synced in keeps it, and so does the run.
    rerender({ s: GameState.Escape });
    expect(result.current).toEqual(ACME_LOOK);
    rerender({ s: GameState.Podium });
    expect(result.current).toEqual(ACME_LOOK);
    rerender({ s: GameState.Lobby });
    expect(result.current).toEqual(NO_LOOK);
    fire('escape:look', ACME_LOOK);
    rerender({ s: GameState.Ended });
    rerender({ s: GameState.Lobby });
    expect(result.current).toEqual(NO_LOOK);
  });

  it('the host coming back (HOST_DISCONNECTED, then the lobby again) keeps it', async () => {
    const { fire } = fakeSocket();
    const { result, rerender } = await mounted(
      ({ s }: { s: string }) => useEscapeLook('123456', 'guest', 1, s),
      { s: GameState.Lobby as string },
    );
    fire('escape:look', ACME_LOOK);
    rerender({ s: GameState.HostDisconnected });
    rerender({ s: GameState.Lobby });
    expect(result.current).toEqual(ACME_LOOK);
  });

  it('no look yet: unbranded', () => {
    fakeSocket();
    const { result } = renderHook(() => useEscapeLook('123456', 'guest', 1, null));
    expect(result.current).toEqual(NO_LOOK);
  });
});

describe('a nested LiveTheme', () => {
  it('overrides the outer one inside its subtree only', () => {
    const outer = BUILTIN_THEME_VALUES.classic;
    const { container } = render(
      <LiveTheme theme={outer}>
        <span data-testid="outside" />
        <LiveTheme theme={ACME_LOOK.theme}>
          <span data-testid="inside" />
        </LiveTheme>
      </LiveTheme>,
    );
    const scopes = container.querySelectorAll<HTMLElement>('[data-theme-scope]');
    expect(scopes).toHaveLength(2);
    expect(scopes[0].style.getPropertyValue('--primary')).toBe(outer.accent);
    expect(scopes[1].style.getPropertyValue('--primary')).toBe('#c2410c');
    // The outer scope's own element is untouched by the inner one.
    expect(scopes[0].contains(container.querySelector('[data-testid="outside"]'))).toBe(true);
    expect(scopes[1].contains(container.querySelector('[data-testid="outside"]'))).toBe(false);
    expect(scopes[1].contains(container.querySelector('[data-testid="inside"]'))).toBe(true);
  });
});
