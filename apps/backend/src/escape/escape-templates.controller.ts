import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  EscapeTemplateContentDto,
  EscapeTemplateDetailDto,
  EscapeTemplateListItemDto,
} from './dto/escape-template.dto';
import { EscapeTemplatesService } from './escape-templates.service';

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
  publish(@CurrentUser() user: User, @Param('id') id: string) {
    return this.templates.publish(user.id, id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @ApiOkResponse({ type: EscapeTemplateDetailDto })
  unpublish(@CurrentUser() user: User, @Param('id') id: string) {
    return this.templates.unpublish(user.id, id);
  }
}
