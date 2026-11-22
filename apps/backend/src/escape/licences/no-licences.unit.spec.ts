import type { LicencePort } from './licence.port';
import { NoLicences } from './no-licences';

describe('NoLicences (ESCAPE_LICENCE_SOURCE=none)', () => {
  const host = { userId: 'u1', email: 'a@b.c', oidcSubject: 's1' };

  it('has no licence for anyone', async () => {
    const port: LicencePort = new NoLicences();
    expect(await port.usableBy(host, Date.now())).toEqual([]);
    expect(await port.check(host, 'lic', Date.now())).toEqual({ ok: false, reason: 'not-found' });
    expect(
      await port.recordUse('lic', {
        useKey: 'g',
        pin: '123456',
        gameId: 'g',
        startedAt: 0,
        players: 1,
      }),
    ).toEqual({ ok: false, reason: 'not-found' });
  });
});
