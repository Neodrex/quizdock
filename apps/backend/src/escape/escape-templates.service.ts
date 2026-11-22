import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EscapeTemplateStatus, type EscapeTemplate as EscapeTemplateRow } from '@prisma/client';
import { type EscapeTemplateContent, escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { ZodValidationException } from 'nestjs-zod';
import { PrismaService } from '../prisma/prisma.service';
import { validateTemplate } from './escape-template';
import { SAMPLES } from './samples';

const NOT_ARCHIVED = { not: EscapeTemplateStatus.archived };

/** A template as its owner reads it: the row, its content re-parsed, no owner id. */
export interface EscapeTemplateDetail {
  id: string;
  title: string;
  status: EscapeTemplateStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  content: EscapeTemplateContent;
}

/** A template in the owner's list: what the picker shows, no content. */
export interface EscapeTemplateListItem {
  id: string;
  title: string;
  status: EscapeTemplateStatus;
  version: number;
  updatedAt: Date;
  /** Null (all four) when the stored content no longer fits the schema. */
  mode: EscapeTemplateContent['mode'] | null;
  difficulty: EscapeTemplateContent['difficulty'] | null;
  targetMinutes: number | null;
  stageCount: number | null;
}

/** A client's content, checked against the shared schema: a 400 with the zod issues. */
function parseInput(content: unknown): EscapeTemplateContent {
  const parsed = escapeTemplateContentSchema.safeParse(content);
  if (!parsed.success) throw new ZodValidationException(parsed.error);
  return parsed.data;
}

/** Problems with running it, as a 400 the editor can list. */
function assertFinishable(id: string, content: EscapeTemplateContent): void {
  const problems = validateTemplate({ id, ...content });
  if (problems.length) {
    throw new BadRequestException({ code: 'escape_template.invalid', problems });
  }
}

function toDetail(row: EscapeTemplateRow): EscapeTemplateDetail {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Stored JSON is read back through the schema, never cast.
    content: escapeTemplateContentSchema.parse(row.content),
  };
}

/** The escape templates of a host: ownership, and publish only what can be finished. */
@Injectable()
export class EscapeTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The owner's templates, most recently changed first; removed (archived) ones
   * left out. Each says what the picker shows (mode, difficulty, length, stage
   * count), never its content; null when its stored content fails the schema.
   */
  async list(ownerId: string): Promise<EscapeTemplateListItem[]> {
    const rows = await this.prisma.escapeTemplate.findMany({
      where: { ownerId, status: NOT_ARCHIVED },
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
    return rows.map((row) => {
      // A row the schema no longer accepts keeps its place without picker fields,
      // rather than failing the whole list.
      const parsed = escapeTemplateContentSchema.safeParse(row.content);
      const c = parsed.success ? parsed.data : null;
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        version: row.version,
        updatedAt: row.updatedAt,
        mode: c?.mode ?? null,
        difficulty: c?.difficulty ?? null,
        targetMinutes: c?.targetMinutes ?? null,
        stageCount: c ? c.stages.length : null,
      };
    });
  }

  async create(ownerId: string, input: unknown): Promise<EscapeTemplateDetail> {
    const content = parseInput(input);
    const row = await this.prisma.escapeTemplate.create({
      data: { ownerId, title: content.title, status: EscapeTemplateStatus.draft, content },
    });
    return toDetail(row);
  }

  /** Adds the sample templates as drafts, skipping any title the owner already has. */
  async createSamples(ownerId: string): Promise<EscapeTemplateDetail[]> {
    const existing = await this.prisma.escapeTemplate.findMany({
      where: { ownerId, title: { in: SAMPLES.map((s) => s.title) }, status: NOT_ARCHIVED },
      select: { title: true },
    });
    const taken = new Set(existing.map((r) => r.title));
    const created: EscapeTemplateDetail[] = [];
    for (const sample of SAMPLES) {
      if (!taken.has(sample.title)) created.push(await this.create(ownerId, sample));
    }
    return created;
  }

  async get(ownerId: string, id: string): Promise<EscapeTemplateDetail> {
    return toDetail(await this.find(ownerId, id));
  }

  /** A published template keeps only content that can still be finished (a live room). */
  async update(ownerId: string, id: string, input: unknown): Promise<EscapeTemplateDetail> {
    const content = parseInput(input);
    const row = await this.find(ownerId, id);
    if (row.status === EscapeTemplateStatus.published) assertFinishable(row.id, content);
    return toDetail(
      await this.prisma.escapeTemplate.update({
        where: { id: row.id },
        data: { title: content.title, content },
      }),
    );
  }

  async publish(ownerId: string, id: string): Promise<EscapeTemplateDetail> {
    const row = await this.find(ownerId, id);
    assertFinishable(row.id, escapeTemplateContentSchema.parse(row.content));
    return toDetail(
      await this.prisma.escapeTemplate.update({
        where: { id: row.id },
        data: { status: EscapeTemplateStatus.published, version: row.version + 1 },
      }),
    );
  }

  async unpublish(ownerId: string, id: string): Promise<EscapeTemplateDetail> {
    const row = await this.find(ownerId, id);
    return toDetail(
      await this.prisma.escapeTemplate.update({
        where: { id: row.id },
        data: { status: EscapeTemplateStatus.draft },
      }),
    );
  }

  /** A draft goes; a published one is archived, as sessions may refer to it. */
  async remove(ownerId: string, id: string): Promise<void> {
    const row = await this.find(ownerId, id);
    if (row.status === EscapeTemplateStatus.draft) {
      await this.prisma.escapeTemplate.delete({ where: { id: row.id } });
    } else {
      await this.prisma.escapeTemplate.update({
        where: { id: row.id },
        data: { status: EscapeTemplateStatus.archived },
      });
    }
  }

  /** The owner's template; another owner's reads as missing, never as forbidden. */
  private async find(ownerId: string, id: string): Promise<EscapeTemplateRow> {
    const row = await this.prisma.escapeTemplate.findFirst({
      where: { id, ownerId, status: NOT_ARCHIVED },
    });
    if (!row) throw new NotFoundException('escape_template.not_found');
    return row;
  }
}
