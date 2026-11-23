import { bootGameApp } from '../../test/game-harness';
import {
  type EscapeContext,
  dropTemplates,
  fastTimings,
  seedTemplate,
  useLicences,
  useStaticLicenceSource,
} from '../../test/escape/escape-harness';
import { brandTests } from '../../test/escape/brand';
import { capTests } from '../../test/escape/caps';
import { clockTests } from '../../test/escape/clock';
import { finaleTests } from '../../test/escape/finale';
import { hintTests } from '../../test/escape/hints';
import { lobbyTests } from '../../test/escape/lobby';
import { playTests } from '../../test/escape/play';
import { presenceTests } from '../../test/escape/presence';
import { raceSessionTests } from '../../test/escape/race';
import { raceTests } from '../../test/escape/races';
import { screenTests } from '../../test/escape/screen';
import { sessionLeakTests } from '../../test/escape/session-leaks';
import { siteLicenceTests } from '../../test/escape/site-licences';
import { siteRaceTests } from '../../test/escape/site-races';
import { phoneHostTests, sessionTests } from '../../test/escape/sessions';
import { vaultHeistRunTests } from '../../test/escape/vault-heist-run';
import { vaultHeist } from './samples';

/**
 * Escape integration (M3): real socket.io clients against both gateways of the
 * `/game` namespace. Needs Postgres and Redis (the worker's test copies). One
 * entry file, one app, one domain per module in test/escape/. Run one domain
 * with `pnpm exec jest src/escape/escape.gateway.spec.ts -t lobby`.
 */
describe('EscapeGateway (socket integration)', () => {
  const ctx = {} as EscapeContext;

  beforeAll(async () => {
    useStaticLicenceSource();
    ctx.h = await bootGameApp();
    useLicences(ctx.h);
    fastTimings(ctx.h);
    ctx.templateId = await seedTemplate(ctx.h, vaultHeist);
    ctx.vault = { id: ctx.templateId, ...vaultHeist };
  }, 30_000);

  afterAll(async () => {
    if (!ctx.h) return;
    await dropTemplates(ctx.h);
    await ctx.h.close();
  });

  describe('lobby', () => lobbyTests(ctx));
  describe('play', () => playTests(ctx));
  describe('hints', () => hintTests(ctx));
  describe('clock', () => clockTests(ctx));
  describe('presence', () => presenceTests(ctx));
  describe('finale', () => finaleTests(ctx));
  describe('races', () => raceTests(ctx));
  describe('screen', () => screenTests(ctx));
  describe('vault heist', () => vaultHeistRunTests(ctx));
  describe('sessions', () => sessionTests(ctx));
  describe('caps', () => capTests(ctx));
  describe('phone host', () => phoneHostTests(ctx));
  describe('race', () => raceSessionTests(ctx));
  describe('brand', () => brandTests(ctx));
  describe('session leaks', () => sessionLeakTests(ctx));
  describe('site licences', () => siteLicenceTests(ctx));
  describe('site races', () => siteRaceTests(ctx));
});
