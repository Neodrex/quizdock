import type { EscapeScreenFinale } from '@quiz-dock/contracts';
import { AlarmClockPlus, Award, CircleCheck, Hourglass, Lightbulb, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatClock } from '../team-timer';
import type { EscapeScreenUi } from './screen-reducer';
import { SplitReplay } from './split-replay';

type Ranked = EscapeScreenFinale['ranking'][number];
type Awards = EscapeScreenFinale['awards'];
const AWARDS: (keyof Awards)[] = ['fastest', 'fewestHints', 'teamwork', 'photoFinish'];
/**
 * Teams listed under the podium, in two columns of two rows; past that, a count. The
 * results hold about 32 em of height (screen-layout.ts): the title and one line under
 * it (5.4 em), the podium (13.8 em), the awards on up to two rows (4.4 em) and the
 * gaps leave room for two rows of 2.6 em. Nothing scrolls on a TV.
 */
const LISTED = 4;

/**
 * The big screen's finale (M6 Task 6.13), in order: the template's closing text, the
 * split-time replay (once), then the podium (places 1–3 with time, hints, penalty and
 * members by nickname), the other teams in a ranked list, and the awards earned. Only
 * what the screen finale carries: no extra time, no host unlocks. Closed: "Thanks for
 * playing" under the results.
 */
export function ScreenFinale({
  finale,
  replay,
  closed,
  onReplayDone,
}: {
  finale: EscapeScreenFinale;
  replay: EscapeScreenUi['replay'];
  closed: boolean;
  onReplayDone: () => void;
}) {
  const { t } = useTranslation('escape');
  const replaying = replay !== 'done';
  return (
    <section
      data-testid="screen-finale"
      className="flex h-full min-h-0 w-full flex-col items-center gap-[0.8em]"
    >
      <header className="flex shrink-0 flex-col items-center gap-[0.3em] text-center">
        <h1 className="flex items-center gap-[0.4em] text-[2.4em] leading-tight font-bold">
          <Trophy aria-hidden className="text-primary size-[1em]" />
          {finale.title}
        </h1>
        {/* Closed: the thanks take the closing text's line, so the results still fit. */}
        {closed && !replaying ? (
          <p className="text-[1.4em] font-bold">{t('screen.finale.thanks')}</p>
        ) : finale.finale ? (
          <p
            className={cn(
              'max-w-[40em] font-medium whitespace-pre-line',
              replaying ? 'line-clamp-3 text-[1.4em]' : 'line-clamp-1 text-[1.1em]',
            )}
          >
            {finale.finale}
          </p>
        ) : null}
      </header>
      {replaying ? (
        <SplitReplay finale={finale} onDone={onReplayDone} />
      ) : (
        <Results finale={finale} />
      )}
      {closed && replaying && (
        <p className="shrink-0 text-[1.4em] font-bold">{t('screen.finale.thanks')}</p>
      )}
    </section>
  );
}

function Results({ finale }: { finale: EscapeScreenFinale }) {
  const { t } = useTranslation('escape');
  const podium = finale.ranking.slice(0, 3);
  const listed = finale.ranking.slice(3, 3 + LISTED);
  const more = finale.ranking.length - 3 - listed.length;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-[0.8em]">
      <h2 className="sr-only">{t('screen.finale.podium')}</h2>
      <ol data-testid="podium" className="flex shrink-0 items-end justify-center gap-[1em]">
        {podium.map((r, i) => (
          <PodiumStep key={r.teamId} team={r} index={i} />
        ))}
      </ol>
      {listed.length > 0 && (
        <>
          <h2 className="sr-only">{t('finale.ranking')}</h2>
          <ol
            data-testid="ranked-list"
            className="grid min-h-0 grid-cols-2 gap-x-[1em] gap-y-[0.3em]"
          >
            {listed.map((r) => (
              <RankedRow key={r.teamId} team={r} />
            ))}
          </ol>
        </>
      )}
      {more > 0 && (
        <p className="text-[1.1em] font-semibold">{t('screen.track.more', { count: more })}</p>
      )}
      <AwardsList finale={finale} />
    </div>
  );
}

/**
 * Escape time, hints and the penalty they added; or "Time up" and the stages cleared.
 * `short` (a ranked row, half the screen wide): one line, the numbers by their icons,
 * the words for screen readers; "Time up" stays a word (no score beside it).
 */
function Outcome({ team, short = false }: { team: Ranked; short?: boolean }) {
  const { t } = useTranslation('escape');
  const escapedAt = team.stageClearedAt[team.stageClearedAt.length - 1];
  const said = (words: string, shown: string) =>
    short ? (
      <>
        <span className="sr-only">{words}</span>
        <span aria-hidden="true">{shown}</span>
      </>
    ) : (
      words
    );
  const escapedTime = formatClock(escapedAt ?? 0);
  const penalty = formatClock(team.hintPenaltyS * 1000);
  return (
    <span
      className={cn(
        'flex items-center gap-x-[0.8em] gap-y-[0.1em] font-semibold tabular-nums',
        short ? 'shrink-0 flex-nowrap' : 'flex-wrap justify-center',
      )}
    >
      {team.escaped ? (
        <span className="flex items-center gap-[0.2em]">
          <CircleCheck aria-hidden className="size-[1em]" />
          {said(t('screen.finale.escapedIn', { time: escapedTime }), escapedTime)}
        </span>
      ) : (
        <span className="flex items-center gap-[0.2em]">
          <Hourglass aria-hidden className="size-[1em]" />
          {t('screen.track.timeUp')} · {t('finale.stages', { done: team.stagesCleared })}
        </span>
      )}
      <span className="flex items-center gap-[0.2em]">
        <Lightbulb aria-hidden className="size-[1em]" />
        {said(t('finale.hints', { count: team.hintsUsed }), String(team.hintsUsed))}
      </span>
      {team.hintPenaltyS > 0 && (
        // The words in the card's own colour (contrast); the red is the icon's.
        <span className="flex items-center gap-[0.2em] font-bold">
          <AlarmClockPlus aria-hidden className="text-destructive size-[1em]" />
          {said(t('screen.finale.penalty', { time: penalty }), `+${penalty}`)}
        </span>
      )}
    </span>
  );
}

function Place({ place }: { place: number }) {
  const { t } = useTranslation('escape');
  return (
    <span className="bg-primary text-primary-foreground flex min-w-[2.4em] shrink-0 justify-center rounded-full px-[0.3em] text-[1.2em] font-bold tabular-nums">
      <span className="sr-only">{t('screen.track.placeLabel', { place })}</span>
      <span aria-hidden="true">{t('screen.track.place', { place })}</span>
    </span>
  );
}

function PodiumStep({ team, index }: { team: Ranked; index: number }) {
  // Visually 2 · 1 · 3, with the winner raised; read in place order.
  // By position on the podium, not by place: tied places (1, 1, 3) keep a spot each.
  const order = ['order-2', 'order-1', 'order-3'][index] ?? 'order-3';
  return (
    <li
      data-testid="podium-step"
      data-place={team.place}
      className={cn(
        // Three steps of up to 18em, narrower when the screen is (4:3 projectors).
        'bg-card text-card-foreground flex max-w-[18em] min-w-0 flex-1 basis-0 flex-col items-center gap-[0.3em] rounded-[0.6em] border-[0.1em] p-[0.6em] text-center',
        order,
        team.place === 1 && 'border-primary pb-[1.5em]',
      )}
    >
      <Place place={team.place} />
      <span className="max-w-full truncate text-[1.6em] leading-tight font-bold">{team.name}</span>
      {team.scoreMs !== null && (
        <span className="font-mono text-[2em] leading-none font-bold tabular-nums">
          {formatClock(team.scoreMs)}
        </span>
      )}
      <Outcome team={team} />
      {team.members.length > 0 && (
        <span data-testid="members" className="line-clamp-1 text-[1em] font-medium">
          {team.members.join(', ')}
        </span>
      )}
    </li>
  );
}

function RankedRow({ team }: { team: Ranked }) {
  return (
    <li
      data-testid="ranked-row"
      className="bg-card text-card-foreground flex min-w-0 items-center gap-[0.8em] rounded-[0.5em] border-[0.1em] px-[0.6em] py-[0.2em]"
    >
      <Place place={team.place} />
      <span className="w-[7em] min-w-0 shrink truncate text-[1.2em] font-bold">{team.name}</span>
      {team.scoreMs !== null && (
        <span className="shrink-0 font-mono text-[1.1em] font-bold tabular-nums">
          {formatClock(team.scoreMs)}
        </span>
      )}
      <Outcome team={team} short />
      <span data-testid="members" className="min-w-0 flex-1 truncate text-right text-[1em]">
        {team.members.join(', ')}
      </span>
    </li>
  );
}

/** A photo finish's gap in seconds: tenths under 10 s (never "0 s"), whole seconds above. */
function gapSeconds(gapMs: number, lng: string): string {
  const tenths = gapMs < 10_000;
  const value = tenths ? Math.max(0.1, Math.round(gapMs / 100) / 10) : Math.round(gapMs / 1000);
  return new Intl.NumberFormat(lng, { maximumFractionDigits: tenths ? 1 : 0 }).format(value);
}

function AwardsList({ finale }: { finale: EscapeScreenFinale }) {
  const { t, i18n } = useTranslation('escape');
  const byId = new Map(finale.ranking.map((r) => [r.teamId, r]));
  const name = (id: string) => byId.get(id)?.name ?? '';
  const items = AWARDS.flatMap((key) => {
    const v = finale.awards[key];
    if (!v) return [];
    if (Array.isArray(v)) {
      const [a, b] = v.map((id) => byId.get(id));
      const gapMs =
        a?.scoreMs != null && b?.scoreMs != null ? Math.abs(a.scoreMs - b.scoreMs) : null;
      const params = { a: name(v[0]), b: name(v[1]) };
      return [
        {
          key,
          text:
            gapMs === null
              ? t('screen.finale.award.photoFinishPair', params)
              : t('screen.finale.award.photoFinish', {
                  ...params,
                  seconds: gapSeconds(gapMs, i18n.language),
                }),
        },
      ];
    }
    return [{ key, text: t(`screen.finale.award.${key}`, { team: name(v) }) }];
  });
  if (!items.length) return null;
  return (
    <div className="flex shrink-0 flex-col items-center gap-[0.3em]">
      <h2 className="sr-only">{t('finale.awards')}</h2>
      <ul className="flex flex-wrap justify-center gap-[0.6em]">
        {items.map(({ key, text }) => (
          <li
            key={key}
            data-award={key}
            className="bg-card text-card-foreground flex items-center gap-[0.3em] rounded-full border-[0.1em] px-[0.8em] py-[0.2em] text-[1em] font-semibold"
          >
            <Award aria-hidden className="text-primary size-[1em]" />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
