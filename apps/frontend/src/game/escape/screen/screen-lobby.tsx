import type { EscapeBoard, EscapeBrand } from '@quiz-dock/contracts';
import { Loader2, Smartphone, Users, WifiOff } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';
import { joinHostLabel, joinUrlFor } from '../../join-url';
import type { GameView } from '../../use-game-session';
import { RaceCountdown } from '../session/race-countdown';
import { type LobbyTeam, lobbyOf } from './screen-reducer';

/** Names shown per team card; the rest are counted ("+3"). */
const NAMES_SHOWN = 8;
/**
 * In a crowded room the cards are small: fewer names each. From 13 teams the grid has
 * 5 to 8 columns and 3 to 6 rows, so a card is about a sixth of the screen's height:
 * the team line, its count and 3 one-line names fit at the screen's type base without
 * a scroll; 8 names would overflow.
 */
const NAMES_SHOWN_COMPACT = 3;
/** From this many teams the cards go compact. */
const COMPACT_FROM = 13;
/** Nicknames of the players with no team, shown before counting the rest. */
const WAITING_SHOWN = 24;

/** Under 3:2 (4:3, 5:4): the lobby stacks the join panel over the teams. */
const NARROW_STACK = '[@media(max-aspect-ratio:3/2)]:flex-col';
/** …and lays the panel out in a row: the QR code, then the address and the PIN. */
const NARROW_ROW =
  '[@media(max-aspect-ratio:3/2)]:flex-row [@media(max-aspect-ratio:3/2)]:gap-[2em]';

/** Columns by team count: up to 30 teams fit the screen without a scroll (M6 §1.8). */
export function lobbyColumns(count: number): string {
  if (count <= 4) return 'grid-cols-2';
  if (count <= 6) return 'grid-cols-3';
  if (count <= 12) return 'grid-cols-4';
  if (count <= 20) return 'grid-cols-5';
  if (count <= 30) return 'grid-cols-6';
  return 'grid-cols-8';
}

/**
 * The big screen before the run (M6 Task 6.7): the PIN, the QR code and the join
 * address, and the teams filling up with their players' nicknames (owner answer 1).
 * Sized in em on the screen's type base; nothing scrolls.
 */
export function ScreenLobby({
  board,
  pin,
  view,
  brand = null,
}: {
  board: EscapeBoard;
  pin: string;
  view: Pick<GameView, 'joinBaseUrl'>;
  /** A hosted event's brand (M7): its intro under the title. */
  brand?: EscapeBrand | null;
}) {
  const { t } = useTranslation('escape');
  const lobby = lobbyOf(board);
  const compact = lobby.teams.length >= COMPACT_FROM;
  // The room's motion, not only the system's: off means no spinner either.
  const spin = useMotionLevel() === 'full';
  return (
    <section className="flex h-full min-h-0 flex-col gap-[1.2em]">
      <h1 className="text-center text-[2em] leading-tight font-bold">{board.title}</h1>
      {brand?.intro ? (
        <p
          data-brand-intro
          className="mx-auto max-w-[40em] text-center text-[1.2em] whitespace-pre-line"
        >
          {brand.intro}
        </p>
      ) : null}
      {/* 16:9 and 16:10: the join panel beside the teams. Narrower (4:3 projectors):
          above them, in a row, so the teams keep the screen's whole width. */}
      <div data-testid="lobby-body" className={cn('flex min-h-0 flex-1 gap-[2em]', NARROW_STACK)}>
        <JoinPanel pin={pin} view={view} />
        {board.session?.type === 'race' ? (
          <RaceLobby board={board} />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[1em]">
            {lobby.teams.length === 0 ? (
              <p className="flex flex-1 flex-col items-center justify-center gap-[0.6em] text-center">
                <Loader2
                  aria-hidden
                  className={cn('text-primary size-[2.5em]', spin && 'motion-safe:animate-spin')}
                />
                <span className="text-[1.6em] font-semibold">{t('lobby.waitingTeams')}</span>
                <span className="text-[1.2em]">
                  {t('screen.lobby.joined', { count: board.roster.length })}
                </span>
              </p>
            ) : (
              <>
                {lobby.selfFormation && (
                  <p className="flex items-center gap-[0.5em] text-[1.4em] font-semibold">
                    <Smartphone aria-hidden className="size-[1.2em] shrink-0" />
                    {t('screen.lobby.pickOnPhone')}
                  </p>
                )}
                <ul
                  aria-label={t('screen.lobby.teams')}
                  className={cn(
                    'grid min-h-0 flex-1 auto-rows-fr gap-[0.8em]',
                    lobbyColumns(lobby.teams.length),
                  )}
                >
                  {lobby.teams.map((team) => (
                    <TeamCard
                      key={team.id}
                      team={team}
                      capped={board.formation.maxSize !== null}
                      compact={compact}
                    />
                  ))}
                </ul>
              </>
            )}
            {/* Before teams exist too: the room sees each player arrive (owner answer 1). */}
            {lobby.waiting.length > 0 && <Waiting names={lobby.waiting} />}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A race's lobby (M7 Task 7.18): up to 500 strangers, so no team cards nor names,
 * the count of players in and the countdown to a scheduled start.
 */
function RaceLobby({ board }: { board: EscapeBoard }) {
  const { t } = useTranslation('escape');
  const startsAt = board.session?.startsAt ?? null;
  const players = board.session?.totals.players ?? board.roster.length;
  return (
    <div
      data-testid="race-lobby"
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-[0.8em] text-center"
    >
      {startsAt !== null ? (
        <RaceCountdown startsAt={startsAt} className="text-[3em] leading-tight font-bold" />
      ) : (
        <p className="text-[2em] font-bold">{t('race.board.waitingStart')}</p>
      )}
      <p className="flex items-center gap-[0.4em] text-[1.6em] font-semibold tabular-nums">
        <Users aria-hidden className="size-[1em]" />
        {t('screen.lobby.joined', { count: players })}
      </p>
    </div>
  );
}

function JoinPanel({ pin, view }: { pin: string; view: Pick<GameView, 'joinBaseUrl'> }) {
  const { t } = useTranslation('escape');
  const host = joinHostLabel(view);
  return (
    <div
      data-testid="join-panel"
      className={cn('flex shrink-0 flex-col items-center justify-center gap-[0.8em]', NARROW_ROW)}
    >
      {/* At least 30% of the screen's height, so a phone reads it from the back row:
          34vh, whatever the width (a 4:3 projector stacks the panel instead). */}
      <div className="shrink-0 rounded-[0.5em] bg-white p-[0.6em]">
        <QRCodeSVG
          value={joinUrlFor(view, pin)}
          size={256}
          aria-label={t('live:screen.qrLabel')}
          className="h-[34vh] w-[34vh]"
        />
      </div>
      <div className="flex flex-col items-center gap-[0.8em]">
        <span className="text-[1.2em]">{t('live:screen.joinAt')}</span>
        <span className="max-w-[16em] text-center text-[1.5em] font-bold [overflow-wrap:anywhere]">
          {host}
        </span>
        {/* Read digit by digit; the large digits are for the room. */}
        <span data-testid="lobby-pin">
          <span className="sr-only">
            {t('screen.lobby.pin', { digits: pin.split('').join(' ') })}
          </span>
          <span
            aria-hidden="true"
            className="font-mono text-[6em] leading-none font-bold tracking-[0.1em] tabular-nums"
          >
            {pin}
          </span>
        </span>
      </div>
    </div>
  );
}

function TeamCard({
  team,
  capped,
  compact,
}: {
  team: LobbyTeam;
  capped: boolean;
  compact: boolean;
}) {
  const { t } = useTranslation('escape');
  const max = compact ? NAMES_SHOWN_COMPACT : NAMES_SHOWN;
  const shown = team.members.slice(0, max);
  const more = team.members.length - shown.length;
  return (
    <li
      className={cn(
        'bg-card text-card-foreground flex min-h-0 min-w-0 flex-col gap-[0.4em] overflow-hidden rounded-[0.6em] border-[0.12em] p-[0.6em]',
        team.full && 'border-primary',
      )}
    >
      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="min-w-0 truncate text-[1.4em] leading-tight font-bold">{team.name}</span>
        <span className="flex shrink-0 items-center gap-[0.3em] text-[1em] font-semibold tabular-nums">
          <Users aria-hidden className="size-[1em]" />
          {capped ? team.label : t('screen.lobby.players', { count: team.count })}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="flex min-h-0 flex-col gap-[0.15em]">
          {shown.map((m, i) => (
            <li key={`${i}-${m.nickname}`} className="flex min-w-0 items-center gap-[0.3em]">
              <span
                // Offline in words (the icon's label) and italics, never faded (7:1).
                className={cn('min-w-0 truncate text-[1em]', !m.connected && 'italic')}
                title={m.nickname}
              >
                {m.nickname}
              </span>
              {!m.connected && (
                <WifiOff
                  role="img"
                  aria-label={t('lobby.offline')}
                  className="size-[0.9em] shrink-0"
                />
              )}
            </li>
          ))}
          {more > 0 && <li className="text-[1em] font-semibold">+{more}</li>}
        </ul>
      )}
    </li>
  );
}

function Waiting({ names }: { names: string[] }) {
  const { t } = useTranslation('escape');
  const shown = names.slice(0, WAITING_SHOWN);
  const more = names.length - shown.length;
  return (
    <div className="flex min-w-0 items-baseline gap-[0.6em]">
      <span className="shrink-0 text-[1.1em] font-semibold">{t('screen.lobby.waiting')}</span>
      <ul
        aria-label={t('screen.lobby.waiting')}
        className="flex min-w-0 flex-wrap gap-[0.4em] overflow-hidden"
      >
        {shown.map((n, i) => (
          <li
            key={`${i}-${n}`}
            className="max-w-[12em] truncate rounded-full border px-[0.6em] text-[1em]"
          >
            {n}
          </li>
        ))}
        {more > 0 && <li className="text-[1em] font-semibold">+{more}</li>}
      </ul>
    </div>
  );
}
