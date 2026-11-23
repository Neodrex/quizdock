import { BUILTIN_THEME_VALUES, GameState } from '@quiz-dock/contracts';
import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GameSocket } from '../../game-client';
import { LiveTheme } from '../../theme';
import { ACME_LOOK } from './look-fixtures';
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
  return { socket: socket as unknown as GameSocket, listeners, fire };
}

describe('useEscapeLook', () => {
  it('keeps the last look, and lets its listener go on unmount', () => {
    const { socket, listeners, fire } = fakeSocket();
    const { result, unmount } = renderHook(() => useEscapeLook(socket, GameState.Escape));
    expect(result.current).toEqual(NO_LOOK);
    fire('escape:look', ACME_LOOK);
    expect(result.current).toEqual(ACME_LOOK);
    fire('escape:look', NO_LOOK);
    expect(result.current).toEqual(NO_LOOK);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('a room switch (back to the lobby after a finale) drops it until a new look', () => {
    const { socket, fire } = fakeSocket();
    const { result, rerender } = renderHook(({ s }) => useEscapeLook(socket, s), {
      initialProps: { s: GameState.Lobby as string },
    });
    fire('escape:look', ACME_LOOK);
    // The lobby it was synced in keeps it, and so does the run.
    rerender({ s: GameState.Escape });
    expect(result.current).toEqual(ACME_LOOK);
    rerender({ s: GameState.Lobby });
    expect(result.current).toEqual(NO_LOOK);
  });

  it('no socket yet: unbranded', () => {
    const { result } = renderHook(() => useEscapeLook(null, null));
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
