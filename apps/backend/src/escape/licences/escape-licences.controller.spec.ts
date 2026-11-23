import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthProvider } from '../../auth/auth-provider';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { buildSwaggerDocument } from '../../swagger';
import type { UsersService } from '../../users/users.service';
import { ACME_LICENCE, DEV_LICENCE, DEV_LICENCES } from './dev-licences';
import { EscapeLicencesController } from './escape-licences.controller';
import { LICENCE_PORT, type LicencePort } from './licence.port';
import { NoLicences } from './no-licences';
import { StaticLicences } from './static-licences';

describe('EscapeLicencesController', () => {
  let app: INestApplication;
  let port: LicencePort;
  const as = (role: string) => ({ 'X-Test-Role': role });
  const proxy: Pick<LicencePort, 'usableBy'> = {
    usableBy: (host, now) => port.usableBy(host, now),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EscapeLicencesController],
      providers: [{ provide: LICENCE_PORT, useValue: proxy }],
    }).compile();
    app = module.createNestApplication();
    const provider: AuthProvider = {
      authenticate: async (req) => {
        const role = req.headers['x-test-role'];
        return typeof role === 'string'
          ? { sub: role, displayName: role, email: null, roles: [role] }
          : null;
      },
    };
    const users = {
      upsertFromPrincipal: async (p: { roles: string[] }) => ({
        id: 'user-1',
        email: 'host@example.com',
        oidcSubject: 'sub-1',
        roles: p.roles,
      }),
    };
    app.useGlobalGuards(new AuthGuard(provider, users as unknown as UsersService, new Reflector()));
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    port = new StaticLicences(DEV_LICENCES);
  });

  const list = () => request(app.getHttpServer()).get('/escape-licences');

  it.each([
    ['', 401],
    ['player', 403],
  ])('%s receives %s: hosts only', async (role, status) => {
    const spy = jest.spyOn(proxy, 'usableBy');
    const call = list();
    if (role) call.set(as(role));
    await call.expect(status);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('the host gets their usable licences only, sorted by expiry, as summaries', async () => {
    const soon = Date.now() + 86_400_000;
    port = new StaticLicences([
      ...DEV_LICENCES,
      { ...ACME_LICENCE, id: 'theirs', hosts: ['someone-else'] },
      { ...ACME_LICENCE, id: 'by-email', expiresAt: soon, hosts: ['HOST@example.com'] },
    ]);
    const res = await list().set(as('host')).expect(200);
    expect(res.body).toEqual([
      {
        id: 'by-email',
        organisationName: 'Acme',
        package: 'bundle',
        participantCap: 8,
        expiresAt: soon,
        eventsLeft: 2,
        hasBrand: true,
      },
      // Equal expiries keep the source's order.
      {
        id: 'dev-licence',
        organisationName: null,
        package: 'annual',
        participantCap: 500,
        expiresAt: DEV_LICENCE.expiresAt,
        eventsLeft: null,
        hasBrand: false,
      },
      {
        id: 'acme',
        organisationName: 'Acme',
        package: 'bundle',
        participantCap: 8,
        expiresAt: ACME_LICENCE.expiresAt,
        eventsLeft: 2,
        hasBrand: true,
      },
    ]);
    // Expired Co and someone else's are left out; no brand details nor hosts.
    expect(JSON.stringify(res.body)).not.toMatch(/expired-co|theirs|hosts|logoUrl|acme-org/);
  });

  it('asks the port as the signed-in host', async () => {
    const spy = jest.spyOn(proxy, 'usableBy');
    await list().set(as('host')).expect(200);
    expect(spy).toHaveBeenCalledWith(
      { userId: 'user-1', email: 'host@example.com', oidcSubject: 'sub-1' },
      expect.any(Number),
    );
    spy.mockRestore();
  });

  it('the source none gives []', async () => {
    port = new NoLicences();
    const res = await list().set(as('host')).expect(200);
    expect(res.body).toEqual([]);
  });

  it('the OpenAPI document lists the route as EscapeLicencesController_list', () => {
    const doc = buildSwaggerDocument(app);
    const get = doc.paths['/escape-licences']?.get;
    expect(get?.operationId).toBe('EscapeLicencesController_list');
    const ok = get?.responses['200'] as { content?: Record<string, { schema?: unknown }> };
    expect(JSON.stringify(ok?.content)).toContain('EscapeLicenceSummaryDto');
  });
});
