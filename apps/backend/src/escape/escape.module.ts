import { Module } from '@nestjs/common';
import { GameStateModule } from '../game/game-state.module';
import { EscapeAttempts } from './escape-attempts';
import { EscapeTemplatesController } from './escape-templates.controller';
import { EscapeTemplatesService } from './escape-templates.service';
import { EscapeTimings } from './escape-timings';
import { EscapeEngine } from './escape.engine';
import { EscapeGateway } from './escape.gateway';
import { EscapeStore } from './escape.store';
import { EscapeLicencesController } from './licences/escape-licences.controller';
import { LicencesModule } from './licences/licences.module';

/** Live escape rooms: their templates (M2) and the live run over the `/game` namespace (M3). */
@Module({
  imports: [GameStateModule, LicencesModule],
  controllers: [EscapeTemplatesController, EscapeLicencesController],
  providers: [
    EscapeTemplatesService,
    EscapeTimings,
    EscapeAttempts,
    EscapeStore,
    EscapeEngine,
    EscapeGateway,
  ],
  exports: [EscapeTemplatesService],
})
export class EscapeModule {}
