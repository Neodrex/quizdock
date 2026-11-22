import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthProvider } from '../auth/auth-provider';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import type { UsersService } from '../users/users.service';
import { EscapeTemplatesController } from './escape-templates.controller';
import { EscapeTemplatesService } from './escape-templates.service';
import { tpl } from './fixtures';

const content = escapeTemplateContentSchema.parse(tpl);

describe('EscapeTemplatesController', () => {
  let app: INestApplication;
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'e1' }),
    get: jest.fn().mockResolvedValue({ id: 'e1' }),
    update: jest.fn().mockResolvedValue({ id: 'e1' }),
    remove: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue({ id: 'e1' }),
    unpublish: jest.fn().mockResolvedValue({ id: 'e1' }),
    createSamples: jest.fn().mockResolvedValue([{ id: 'e2' }]),
  };
  const as = (role: string) => ({ 'X-Test-Role': role });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EscapeTemplatesController],
      providers: [{ provide: EscapeTemplatesService, useValue: service }],
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
      upsertFromPrincipal: async (p: { roles: string[] }) => ({ id: 'user-1', roles: p.roles }),
    };
    app.useGlobalGuards(new AuthGuard(provider, users as unknown as UsersService, new Reflector()));
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new HttpExceptionFilter());
    // Listening on 127.0.0.1, which supertest reuses (why: test/game-harness.ts).
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    Object.values(service).forEach((fn) => fn.mockClear());
  });

  it('GET /escape-templates sends what the picker shows, drafts and published alike', async () => {
    const item = {
      id: 'e1',
      title: 'Vault Heist',
      version: 0,
      updatedAt: '2026-11-22T10:00:00.000Z',
      mode: 'roles',
      difficulty: 'standard',
      targetMinutes: 40,
      stageCount: 4,
    };
    const items = [
      { ...item, status: 'draft' },
      { ...item, id: 'e2', status: 'published', version: 1 },
    ];
    service.list.mockResolvedValueOnce(items);
    const res = await request(app.getHttpServer())
      .get('/escape-templates')
      .set(as('host'))
      .expect(200);
    expect(res.body).toEqual(items);
  });

  it('publish and samples with ?view=summary answer the list item, never the content', async () => {
    const detail = {
      id: 'e1',
      title: 'T',
      status: 'published',
      version: 1,
      createdAt: new Date('2026-11-22T09:00:00.000Z'),
      updatedAt: new Date('2026-11-22T10:00:00.000Z'),
      content,
    };
    const summary = {
      id: 'e1',
      title: 'T',
      status: 'published',
      version: 1,
      updatedAt: '2026-11-22T10:00:00.000Z',
      mode: 'roles',
      difficulty: 'standard',
      targetMinutes: 35,
      stageCount: content.stages.length,
    };
    service.publish.mockResolvedValueOnce(detail);
    const published = await request(app.getHttpServer())
      .post('/escape-templates/e1/publish?view=summary')
      .set(as('host'))
      .expect(200);
    expect(published.body).toEqual(summary);
    service.createSamples.mockResolvedValueOnce([{ ...detail, status: 'draft' }]);
    const samples = await request(app.getHttpServer())
      .post('/escape-templates/samples?view=summary')
      .set(as('host'))
      .expect(201);
    expect(samples.body).toEqual([{ ...summary, status: 'draft' }]);
    expect(JSON.stringify([published.body, samples.body])).not.toContain('answer');
  });

  it("calls each route's service with the current user's id", async () => {
    const http = () => request(app.getHttpServer());
    await http().get('/escape-templates').set(as('host')).expect(200);
    expect(service.list).toHaveBeenCalledWith('user-1');
    await http().post('/escape-templates').set(as('host')).send(content).expect(201);
    expect(service.create).toHaveBeenCalledWith('user-1', content);
    await http().get('/escape-templates/e1').set(as('host')).expect(200);
    expect(service.get).toHaveBeenCalledWith('user-1', 'e1');
    await http().put('/escape-templates/e1').set(as('host')).send(content).expect(200);
    expect(service.update).toHaveBeenCalledWith('user-1', 'e1', content);
    await http().delete('/escape-templates/e1').set(as('host')).expect(204);
    expect(service.remove).toHaveBeenCalledWith('user-1', 'e1');
    await http().post('/escape-templates/e1/publish').set(as('host')).expect(200);
    expect(service.publish).toHaveBeenCalledWith('user-1', 'e1');
    await http().post('/escape-templates/e1/unpublish').set(as('host')).expect(200);
    expect(service.unpublish).toHaveBeenCalledWith('user-1', 'e1');
    const samples = await http().post('/escape-templates/samples').set(as('host')).expect(201);
    expect(service.createSamples).toHaveBeenCalledWith('user-1');
    expect(samples.body).toEqual([{ id: 'e2' }]);
  });

  it.each([
    ['', 401],
    ['player', 403],
    ['admin', 403],
  ])('%s receives %s: hosts only', async (role, status) => {
    const call = request(app.getHttpServer()).get('/escape-templates');
    if (role) call.set(as(role));
    await call.expect(status);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects a body failing the schema with 400 before the service', async () => {
    for (const send of [
      request(app.getHttpServer()).post('/escape-templates'),
      request(app.getHttpServer()).put('/escape-templates/e1'),
    ]) {
      const res = await send
        .set(as('host'))
        .send({ ...content, targetMinutes: 'soon' })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'validation',
        errors: [{ field: 'targetMinutes', code: 'invalid_type' }],
      });
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("sends the template's problems to the client", async () => {
    const problems = ['A template needs at least 3 stages.'];
    service.publish.mockRejectedValueOnce(
      new BadRequestException({ code: 'escape_template.invalid', problems }),
    );
    const res = await request(app.getHttpServer())
      .post('/escape-templates/e1/publish')
      .set(as('host'))
      .expect(400);
    expect(res.body).toEqual({ code: 'escape_template.invalid', problems });
  });
});
