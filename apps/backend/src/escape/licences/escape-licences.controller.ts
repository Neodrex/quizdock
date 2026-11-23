import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import type { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { EscapeLicenceSummaryDto, type escapeLicenceSummarySchema } from './dto/escape-licence.dto';
import { LICENCE_PORT, type Licence, type LicencePort } from './licence.port';

type Summary = z.infer<typeof escapeLicenceSummarySchema>;

const summaryOf = (l: Licence): Summary => ({
  id: l.id,
  organisationName: l.brand?.name ?? null,
  package: l.package,
  participantCap: l.participantCap,
  expiresAt: l.expiresAt,
  eventsLeft: l.eventsLeft,
  hasBrand: l.brand !== null,
});

/** The licences a host can run a hosted event under (host role, the global guard's default). */
@ApiTags('escape-licences')
@ApiBearerAuth()
@Controller('escape-licences')
export class EscapeLicencesController {
  constructor(@Inject(LICENCE_PORT) private readonly licences: Pick<LicencePort, 'usableBy'>) {}

  /** The host's usable licences now, the soonest to expire first. */
  @Get()
  @ApiOkResponse({ type: EscapeLicenceSummaryDto, isArray: true })
  async list(@CurrentUser() user: User): Promise<Summary[]> {
    const host = { userId: user.id, email: user.email, oidcSubject: user.oidcSubject };
    const usable = await this.licences.usableBy(host, Date.now());
    return usable.sort((a, b) => a.expiresAt - b.expiresAt).map(summaryOf);
  }
}
