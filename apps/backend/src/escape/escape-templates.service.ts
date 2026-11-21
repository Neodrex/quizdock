import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EscapeTemplateStatus, type EscapeTemplate as EscapeTemplateRow } from '@prisma/client';
import { type EscapeTemplateContent, escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { ZodValidationException } from 'nestjs-zod';
import { PrismaService } from '../prisma/prisma.service';
import { validateTemplate } from './escape-template';

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

  /** The owner's templates, most recently changed first; removed (archived) ones left out. */
  list(ownerId: string) {
    return this.prisma.escapeTemplate.findMany({
      where: { ownerId, status: NOT_ARCHIVED },
      select: { id: true, title: true, status: true, version: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(ownerId: string, input: unknown): Promise<EscapeTemplateDetail> {
    const content = parseInput(input);
    const row = await this.prisma.escapeTemplate.create({
      data: { ownerId, title: content.title, status: EscapeTemplateStatus.draft, content },
    });
    return toDetail(row);
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
