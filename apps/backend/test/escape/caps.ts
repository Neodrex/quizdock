import { lostLibrary } from '../../src/escape/samples';
import { DEV_LICENCES } from '../../src/escape/licences/dev-licences';
import {
  type EscapeContext,
  createAs,
  joinAndSync,
  seedTemplate,
  useLicences,
} from './escape-harness';

/** Every session type caps its players at join (M7 Task 7.4, owner question 3). */
export function capTests(ctx: EscapeContext): void {
  let library: string;
  const full = { ok: false, error: expect.objectContaining({ code: 'session.full' }) };

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  afterEach(() => useLicences(ctx.h));

  const joinAck = (pin: string, nickname: string) =>
    ctx.h.connect().emitWithAck('player:join', { pin, nickname });

  it('group play refuses the 7th phone; the console and the screens hold no seat', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    for (const s of [ctx.h.connect(), ctx.h.connect()]) {
      await s.emitWithAck('spectator:join', { pin });
      expect(await s.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    }
    const phones = [];
    for (let i = 0; i < 6; i++) phones.push(await joinAndSync(ctx.h, pin!, `P${i}`));
    expect(await joinAck(pin!, 'P6')).toMatchObject(full);
    // A dropped phone holds its seat and comes back into the full room.
    const [first] = phones;
    first.socket.disconnect();
    expect(await joinAck(pin!, 'P7')).toMatchObject(full);
    const back = ctx.h.connect();
    expect(
      await back.emitWithAck('player:reconnect', { sessionToken: first.sessionToken }),
    ).toMatchObject({ ok: true });
    expect(await back.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
  });

  it('a hosted Acme room refuses the 9th phone', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, ctx.templateId, 'hosted', { licenceId: 'acme' });
    for (let i = 0; i < 8; i++)
      expect(await joinAck(pin!, `A${i}`)).toMatchObject({ playerId: expect.any(String) });
    expect(await joinAck(pin!, 'A8')).toMatchObject(full);
  });
}
