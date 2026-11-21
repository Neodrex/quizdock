import { Module } from '@nestjs/common';
import { EscapeTemplatesController } from './escape-templates.controller';
import { EscapeTemplatesService } from './escape-templates.service';

/** Live escape rooms: their templates, for now (M2). */
@Module({
  controllers: [EscapeTemplatesController],
  providers: [EscapeTemplatesService],
  exports: [EscapeTemplatesService],
})
export class EscapeModule {}
