import type { EscapeLook } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { lostLibrary } from '../../src/escape/samples';
import { ACME_LICENCE, DEV_LICENCES } from '../../src/escape/licences/dev-licences';
import {
  type EscapeContext,
  createAs,
  extraScreens,
  record,
  seedTemplate,
  useLicences,
} from './escape-harness';

const MIN = 60_000;
const UNBRANDED: EscapeLook = { theme: null, brand: null };

/** The escape:look frames `socket` gets from one escape:sync. */
async function looksOfSync(socket: Socket, pin: string): Promise<EscapeLook[]> {
  const seen = record(socket);
  const ack = (await socket.emitWithAck('escape:sync', { pin })) as { ok: boolean };
  if (!ack.ok) throw new Error(`escape:sync refused: ${JSON.stringify(ack)}`);
  // Frames emitted inside the sync arrive before its ack.
  socket.offAny();
  return seen.filter(([e]) => e === 'escape:look').map(([, p]) => p as EscapeLook);
}

/** Every key of a JSON value, nested. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysIn(v)]);
  }
  return [];
}

/** The licence brand on every kind of synced socket (M7 Task 7.10). */
export function brandTests(ctx: EscapeContext): void {
  let library: string;

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  beforeEach(() => useLicences(ctx.h, DEV_LICENCES));
  afterEach(() => useLicences(ctx.h));

  it('Acme’s hosted room: console, phone, paired screen and follow copy get one look per sync', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, ctx.templateId, 'hosted', { licenceId: 'acme' });
    if (!pin) throw new Error('hosted create refused');
    const { socket: phone } = await ctx.h.join(pin, 'Ann');
    const { own, paired, follow } = await extraScreens(ctx.h, pin, host);
    for (const socket of [host, phone, own, paired, follow]) {
      const looks = await looksOfSync(socket, pin);
      expect(looks).toHaveLength(1);
      const [look] = looks;
      expect(look.brand).toEqual({
        name: 'Acme',
        logoUrl: ACME_LICENCE.brand!.logoUrl,
        intro: ACME_LICENCE.brand!.intro,
      });
      expect(look.theme?.accent).toBe('#c2410c');
      // No licence details (§1.4).
      const keys = keysIn(look);
      for (const k of ['id', 'organisationId', 'eventsLeft', 'hosts', 'participantCap']) {
        expect(keys).not.toContain(k);
      }
      expect(JSON.stringify(look)).not.toMatch(/acme-org|"acme"/);
    }
  });

  it('a group room and a race are unbranded', async () => {
    const group = ctx.h.connectHost();
    const { pin: g } = await createAs(group, library, 'group');
    const race = ctx.h.connectHost();
    const { pin: r } = await createAs(race, library, 'race', {
      race: { format: 'solo', startsAt: Date.now() + 30 * MIN },
    });
    if (!g || !r) throw new Error('create refused');
    // The group's creator also plays on its phone (one look for both roles).
    await group.emitWithAck('player:join', { pin: g, nickname: 'Host' });
    expect(await looksOfSync(group, g)).toEqual([UNBRANDED]);
    expect(await looksOfSync(race, r)).toEqual([UNBRANDED]);
    const { socket: phone } = await ctx.h.join(r, 'Ben');
    expect(await looksOfSync(phone, r)).toEqual([UNBRANDED]);
    const { follow } = await extraScreens(ctx.h, r, race);
    expect(await looksOfSync(follow, r)).toEqual([UNBRANDED]);
  });
}
