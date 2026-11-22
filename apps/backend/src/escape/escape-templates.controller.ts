import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  EscapeTemplateContentDto,
  EscapeTemplateDetailDto,
  EscapeTemplateListItemDto,
} from './dto/escape-template.dto';
import { EscapeTemplatesService, summaryOf } from './escape-templates.service';

/**
 * `?view=summary`: the answer is the list item (no content, so no answers), for the
 * host console's picker (M5 owner question 1). Without it, the detail as before.
 */
const summaryQuery = {
  name: 'view',
  required: false,
  enum: ['summary'],
  description: 'summary: answer the list item(s) (no content) instead of the detail',
} as const;

/** A host's escape templates (host role, the global guard's default). */
@ApiTags('escape-templates')
@ApiBearerAuth()
@Controller('escape-templates')
export class EscapeTemplatesController {
  constructor(private readonly templates: EscapeTemplatesService) {}

  @Get()
  @ApiOkResponse({ type: EscapeTemplateListItemDto, isArray: true })
  list(@CurrentUser() user: User) {
    return this.templates.list(user.id);
  }

  @Post()
  @ApiCreatedResponse({ type: EscapeTemplateDetailDto })
  create(@CurrentUser() user: User, @Body() body: EscapeTemplateContentDto) {
    return this.templates.create(user.id, body);
  }

  /** Adds the sample templates as drafts; titles the user already has are skipped. */
  @Post('samples')
  @ApiCreatedResponse({ type: EscapeTemplateDetailDto, isArray: true })
  @ApiQuery(summaryQuery)
  async createSamples(@CurrentUser() user: User, @Query('view') view?: string) {
    const created = await this.templates.createSamples(user.id);
    return view === 'summary' ? created.map(summaryOf) : created;
  }

  @Get(':id')
  @ApiOkResponse({ type: EscapeTemplateDetailDto })
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.templates.get(user.id, id);
  }

  @Put(':id')
  @ApiOkResponse({ type: EscapeTemplateDetailDto })
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: EscapeTemplateContentDto,
  ) {
    return this.templates.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.templates.remove(user.id, id);
  }

  /** Refused with `escape_template.invalid` and its `problems` when it cannot be finished. */
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOkResponse({ type: EscapeTemplateDetailDto })
  @ApiQuery(summaryQuery)
  async publish(@CurrentUser() user: User, @Param('id') id: string, @Query('view') view?: string) {
    const published = await this.templates.publish(user.id, id);
    return view === 'summary' ? summaryOf(published) : published;
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @ApiOkResponse({ type: EscapeTemplateDetailDto })
  unpublish(@CurrentUser() user: User, @Param('id') id: string) {
    return this.templates.unpublish(user.id, id);
  }
}
