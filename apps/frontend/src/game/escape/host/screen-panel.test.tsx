import type { RoomSoundsPayload } from '@quiz-dock/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../test/harness';
import { I18nextProvider } from 'react-i18next';
import { drawEn, en } from '../test-fixtures';
import { ScreenPanel } from './screen-panel';

const PIN = '482913';
const SOUNDS = {
  muted: false,
  musicMuted: false,
  sfxMuted: false,
  musicLevel: 0.6,
  sfxLevel: 0.8,
  tick: true,
  gong: true,
  ding: true,
  countdown: true,
  musicUrl: null,
  tickUrl: null,
  gongUrl: null,
  dingUrl: null,
  countdownUrl: null,
  mediaLevel: 1,
  mediaMuted: false,
} as RoomSoundsPayload;

type Ack = (r: { ok: boolean }) => void;
const socketOf = (ok = true) => ({
  emit: vi.fn((_e: string, _p: unknown, ack?: Ack) => ack?.({ ok })),
});

let setDisabled: (disabled: boolean) => void = () => {};
const draw = (over: Partial<Parameters<typeof ScreenPanel>[0]> = {}) => {
  const socket = over.socket ?? socketOf();
  mockApi([]);
  const el = (disabled: boolean) => (
    <QueryClientProvider client={client}>
      <ScreenPanel
        pin={PIN}
        socket={socket as never}
        sounds={SOUNDS}
        theme={null}
        disabled={disabled}
        {...over}
      />
    </QueryClientProvider>
  );
  const client = new QueryClient();
  const { rerender } = drawEn(el(over.disabled ?? false));
  // The connection drops or comes back (the panel's own provider stays: drawEn's is above).
  setDisabled = (d) => rerender(<I18nextProvider i18n={en}>{el(d)}</I18nextProvider>);
  return socket as ReturnType<typeof socketOf>;
};
const openPairing = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Project from another computer' }));
const codeField = () => screen.getByLabelText('Code shown on that screen');
const pairButton = () => screen.getByRole('button', { name: 'Make it the projection' });

afterEach(() => vi.restoreAllMocks());

describe('ScreenPanel', () => {
  it('opens the big screen in a new tab, without an opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Projection window/ }));
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/session/${PIN}/projection`,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('pairs a screen on another computer by its 4-digit code', () => {
    const socket = draw();
    openPairing();
    expect(screen.getByText(`${window.location.origin}/session/${PIN}/projection`)).toBeVisible();
    fireEvent.change(codeField(), { target: { value: '12a3' } });
    expect(codeField()).toHaveValue('123');
    expect(pairButton()).toBeDisabled();
    fireEvent.submit(codeField().closest('form')!);
    expect(socket.emit).not.toHaveBeenCalled();
    fireEvent.change(codeField(), { target: { value: '12345' } });
    expect(codeField()).toHaveValue('1234');
    fireEvent.click(pairButton());
    expect(socket.emit).toHaveBeenCalledWith(
      'host:pair-screen',
      { pin: PIN, code: '1234' },
      expect.any(Function),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      "That screen is now the lobby's projection.",
    );
    expect(codeField()).toHaveValue('');
  });

  it('says when no screen shows the code', () => {
    draw({ socket: socketOf(false) as never });
    openPairing();
    fireEvent.change(codeField(), { target: { value: '9999' } });
    fireEvent.click(pairButton());
    expect(screen.getByRole('status')).toHaveTextContent(
      'No screen of this lobby shows that code.',
    );
    expect(codeField()).toHaveValue('9999');
  });

  it("the room's sound controls send host:sounds with the patch", () => {
    const socket = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Lobby audio' }));
    const dialog = screen.getByRole('dialog');
    const mute = within(dialog).getByRole('switch', { name: 'Projection audio' });
    fireEvent.click(mute);
    expect(socket.emit).toHaveBeenCalledWith('host:sounds', { pin: PIN, muted: true });
  });

  it('everything is off while the connection is down', () => {
    draw({ disabled: true });
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('a drop with the pairing popover open: no code can go out, and it closes', () => {
    const socket = draw();
    openPairing();
    fireEvent.change(codeField(), { target: { value: '1234' } });
    act(() => setDisabled(true));
    expect(screen.queryByLabelText('Code shown on that screen')).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("a drop with the room's sound dialog open: it closes", () => {
    const socket = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Lobby audio' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => setDisabled(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
