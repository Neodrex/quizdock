import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawEn } from '../test-fixtures';
import { InvitePanel } from './invite-panel';

// The address picker reads the server's addresses: a stand-in that says where it points.
vi.mock('../../join-address-picker', () => ({
  JoinAddressPicker: ({
    current,
    onChange,
    room,
  }: {
    current: string;
    onChange: (u: string) => void;
    room: string;
  }) => (
    <button type="button" onClick={() => onChange('http://192.168.1.20:5173')}>
      address {current} {room}
    </button>
  ),
}));

const PIN = '123456';
const view = { joinBaseUrl: 'http://192.168.1.10:5173' };
const URL = 'http://192.168.1.10:5173/join/123456';

describe('InvitePanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(navigator, { share: undefined, clipboard: undefined });
  });

  it('shows the PIN in large digits, read digit by digit, its QR and its link', () => {
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={vi.fn()} />);
    const pin = screen.getByRole('img', { name: 'PIN 1 2 3 4 5 6' });
    expect(pin).toHaveTextContent(PIN);
    expect(pin.className).toMatch(/text-4xl/);
    expect(screen.getByLabelText('QR code to join')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: URL })).toHaveAttribute('href', URL);
    expect(screen.getByText('192.168.1.10:5173/join')).toBeInTheDocument();
  });

  it('the address picker changes where the QR and the link point', () => {
    const onJoinUrl = vi.fn();
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={onJoinUrl} />);
    fireEvent.click(
      screen.getByRole('button', { name: /address http:\/\/192.168.1.10:5173 123456/ }),
    );
    expect(onJoinUrl).toHaveBeenCalledWith('http://192.168.1.20:5173');
  });

  it('shares with the share sheet first', async () => {
    const share = vi.fn(async () => {});
    Object.assign(navigator, { share });
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ url: URL }));
  });

  it('then the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { share: undefined, clipboard: { writeText } });
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
    expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
  });

  it('then the address to copy by hand', async () => {
    Object.assign(navigator, { share: undefined, clipboard: undefined });
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('status')).toHaveTextContent(URL);
  });

  it('its share button is tap-sized', () => {
    drawEn(<InvitePanel pin={PIN} view={view} onJoinUrl={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Share' }).className).toMatch(/min-h-11/);
  });
});
