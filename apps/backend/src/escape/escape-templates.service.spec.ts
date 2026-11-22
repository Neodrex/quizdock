import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EscapeTemplateStatus } from '@prisma/client';
import { type EscapeTemplateContent, escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { ZodValidationException } from 'nestjs-zod';
import type { PrismaService } from '../prisma/prisma.service';
import { EscapeTemplatesService } from './escape-templates.service';
import { tpl } from './fixtures';
import { SAMPLES } from './samples';

const OWNER = 'owner-1';
const valid: EscapeTemplateContent = escapeTemplateContentSchema.parse(tpl);
/** Fits the schema, but cannot be run: one stage only. */
const unfinishable: EscapeTemplateContent = { ...valid, stages: valid.stages.slice(0, 1) };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    ownerId: OWNER,
    title: valid.title,
    status: EscapeTemplateStatus.draft,
    content: valid,
    version: 0,
    createdAt: new Date('2026-11-21T10:00:00Z'),
    updatedAt: new Date('2026-11-21T11:00:00Z'),
    ...over,
  };
}

function makePrisma() {
  return {
    escapeTemplate: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      delete: jest.fn(async () => row()),
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('EscapeTemplatesService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: EscapeTemplatesService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new EscapeTemplatesService(prisma as unknown as PrismaService);
  });

  it("lists the owner's templates, newest first, archived excluded", async () => {
    prisma.escapeTemplate.findMany.mockResolvedValue([]);
    await expect(service.list(OWNER)).resolves.toEqual([]);
    expect(prisma.escapeTemplate.findMany).toHaveBeenCalledWith({
      where: { ownerId: OWNER, status: { not: EscapeTemplateStatus.archived } },
      select: {
        id: true,
        title: true,
        status: true,
        version: true,
        updatedAt: true,
        content: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('gives each item its mode, difficulty, length and stage count, and no content', async () => {
    const updatedAt = new Date();
    const published = { ...row({ id: 'e2', status: 'published', version: 1, updatedAt }) };
    const draft = { ...row({ id: 'e3', updatedAt, content: { ...valid, mode: 'parallel' } }) };
    prisma.escapeTemplate.findMany.mockResolvedValue([published, draft]);
    const items = await service.list(OWNER);
    const base = {
      title: valid.title,
      difficulty: valid.difficulty,
      targetMinutes: valid.targetMinutes,
      stageCount: valid.stages.length,
      updatedAt,
    };
    expect(items).toEqual([
      { ...base, id: 'e2', status: 'published', version: 1, mode: valid.mode },
      { ...base, id: 'e3', status: 'draft', version: 0, mode: 'parallel' },
    ]);
    expect(JSON.stringify(items)).not.toContain('stages');
    expect(JSON.stringify(items)).not.toContain('answer');
  });

  it('creates a draft titled after its content', async () => {
    const created = await service.create(OWNER, valid);
    expect(prisma.escapeTemplate.create).toHaveBeenCalledWith({
      data: { ownerId: OWNER, title: valid.title, status: 'draft', content: valid },
    });
    expect(created).toMatchObject({ id: 'e1', status: 'draft', content: valid });
  });

  it('content that fails the schema is a 400 with zod issues', async () => {
    const err = await rejection(
      service.create(OWNER, {
        ...valid,
        targetMinutes: 'soon',
      } as unknown as EscapeTemplateContent),
    );
    expect(err).toBeInstanceOf(ZodValidationException);
    expect((err as ZodValidationException).getStatus()).toBe(400);
    expect(prisma.escapeTemplate.create).not.toHaveBeenCalled();
  });

  it("gets the owner's template, its content re-parsed", async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ content: { ...valid, extra: 1 } }));
    const got = await service.get(OWNER, 'e1');
    expect(prisma.escapeTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 'e1', ownerId: OWNER, status: { not: EscapeTemplateStatus.archived } },
    });
    expect(got.content).toEqual(valid);
    expect(got).not.toHaveProperty('ownerId');
  });

  it("a missing or another owner's template is not found", async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(null);
    const err = await rejection(service.get('someone-else', 'e1'));
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('escape_template.not_found');
  });

  it('updates a draft, even one that cannot be run yet', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row());
    await service.update(OWNER, 'e1', unfinishable);
    expect(prisma.escapeTemplate.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { title: unfinishable.title, content: unfinishable },
    });
  });

  it('updates a published template only while it stays finishable', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ status: 'published' }));
    const err = await rejection(service.update(OWNER, 'e1', unfinishable));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'escape_template.invalid',
      problems: [expect.any(String)],
    });
    expect(prisma.escapeTemplate.update).not.toHaveBeenCalled();

    await service.update(OWNER, 'e1', { ...valid, title: 'Renamed' });
    expect(prisma.escapeTemplate.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { title: 'Renamed', content: { ...valid, title: 'Renamed' } },
    });
  });

  it('publishes a finishable template, bumping its version', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ version: 2 }));
    await service.publish(OWNER, 'e1');
    expect(prisma.escapeTemplate.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'published', version: 3 },
    });
  });

  it('refuses to publish a template with problems', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ content: unfinishable }));
    const err = await rejection(service.publish(OWNER, 'e1'));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'escape_template.invalid',
      problems: [expect.stringContaining('stages')],
    });
    expect(prisma.escapeTemplate.update).not.toHaveBeenCalled();
  });

  it('unpublishes back to draft', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ status: 'published' }));
    await service.unpublish(OWNER, 'e1');
    expect(prisma.escapeTemplate.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'draft' },
    });
  });

  it('deletes a draft, archives a published one', async () => {
    prisma.escapeTemplate.findFirst.mockResolvedValue(row());
    await service.remove(OWNER, 'e1');
    expect(prisma.escapeTemplate.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });

    prisma.escapeTemplate.findFirst.mockResolvedValue(row({ status: 'published' }));
    await service.remove(OWNER, 'e1');
    expect(prisma.escapeTemplate.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'archived' },
    });
    expect(prisma.escapeTemplate.delete).toHaveBeenCalledTimes(1);
  });
  it('adds both samples as drafts for the owner', async () => {
    prisma.escapeTemplate.findMany.mockResolvedValue([]);
    const created = await service.createSamples(OWNER);
    expect(prisma.escapeTemplate.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: OWNER,
        title: { in: SAMPLES.map((s) => s.title) },
        status: { not: EscapeTemplateStatus.archived },
      },
      select: { title: true },
    });
    for (const sample of SAMPLES) {
      expect(prisma.escapeTemplate.create).toHaveBeenCalledWith({
        data: { ownerId: OWNER, title: sample.title, status: 'draft', content: sample },
      });
    }
    expect(created.map((d) => d.title)).toEqual(SAMPLES.map((s) => s.title));
  });

  it('skips a sample whose title the owner already has', async () => {
    prisma.escapeTemplate.findMany.mockResolvedValue([{ title: SAMPLES[0].title }]);
    const created = await service.createSamples(OWNER);
    expect(prisma.escapeTemplate.create).toHaveBeenCalledTimes(1);
    expect(prisma.escapeTemplate.create).toHaveBeenCalledWith({
      data: { ownerId: OWNER, title: SAMPLES[1].title, status: 'draft', content: SAMPLES[1] },
    });
    expect(created.map((d) => d.title)).toEqual([SAMPLES[1].title]);

    prisma.escapeTemplate.create.mockClear();
    prisma.escapeTemplate.findMany.mockResolvedValue(SAMPLES.map((s) => ({ title: s.title })));
    await expect(service.createSamples(OWNER)).resolves.toEqual([]);
    expect(prisma.escapeTemplate.create).not.toHaveBeenCalled();
  });
});
