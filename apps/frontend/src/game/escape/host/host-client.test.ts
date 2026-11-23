import { describe, expect, it, vi } from 'vitest';

const { fakeSocket, emitted, acks } = vi.hoisted(() => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const acks = new Map<string, unknown>();
  return {
    emitted,
    acks,
    fakeSocket: {
      emit: (e: string, payload: unknown, ack?: (r: unknown) => void) => {
        emitted.push({ event: e, payload });
        ack?.(acks.get(e) ?? { ok: true });
      },
    },
  };
});

const connectHost = vi.fn(() => Promise.resolve(fakeSocket));
vi.mock('../../game-client', async (orig) => ({
  ...(await orig<typeof import('../../game-client')>()),
  connectHost: () => connectHost(),
}));

import type { GameSocket } from '../../game-client';
import { createEscapeRoom, hostCommand } from './host-client';

const socket = fakeSocket as unknown as GameSocket;

describe('createEscapeRoom', () => {
  it('emits escape:create on a fresh host socket and gives the PIN', async () => {
    acks.set('escape:create', { pin: '482913' });
    await expect(
      createEscapeRoom('tpl-1', { pickOwnName: true, participantAccess: 'open' }),
    ).resolves.toEqual({ pin: '482913' });
    expect(connectHost).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toEqual({
      event: 'escape:create',
      payload: { templateId: 'tpl-1', pickOwnName: true, participantAccess: 'open' },
    });
    // The template's length (owner question 5): no duration is sent.
    expect(emitted.at(-1)!.payload).not.toHaveProperty('durationMin');
  });

  it('sends the session type, the licence and the race (M7)', async () => {
    acks.set('escape:create', { pin: '482913' });
    await createEscapeRoom('tpl-1', {
      sessionType: 'race',
      race: { format: 'teams', startsAt: 5_000_000 },
    });
    expect(emitted.at(-1)!.payload).toEqual({
      templateId: 'tpl-1',
      sessionType: 'race',
      race: { format: 'teams', startsAt: 5_000_000 },
    });
    await createEscapeRoom('tpl-1', { sessionType: 'hosted', licenceId: 'acme' });
    expect(emitted.at(-1)!.payload).toEqual({
      templateId: 'tpl-1',
      sessionType: 'hosted',
      licenceId: 'acme',
    });
  });

  it('rejects with the code of a refusal', async () => {
    acks.set('escape:create', { ok: false, error: { code: 'escape_template.invalid' } });
    await expect(createEscapeRoom('tpl-1')).rejects.toMatchObject({
      code: 'escape_template.invalid',
    });
  });
});

describe('hostCommand', () => {
  it('resolves the accepted answer', async () => {
    acks.set('escape:hint', { ok: true, released: 2 });
    const ack = await hostCommand(socket, 'escape:hint', { pin: '482913', teamId: 't1' });
    expect(ack.released).toBe(2);
    expect(emitted.at(-1)).toEqual({
      event: 'escape:hint',
      payload: { pin: '482913', teamId: 't1' },
    });
  });

  it('rejects with the code on a refusal', async () => {
    acks.set('escape:start', { ok: false, error: { code: 'escape.wrong_phase' } });
    await expect(hostCommand(socket, 'escape:start', { pin: '482913' })).rejects.toMatchObject({
      code: 'escape.wrong_phase',
    });
  });
});
