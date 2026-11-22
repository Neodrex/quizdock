import type { EscapeFinale } from '@quiz-dock/contracts';
import { Link } from '@tanstack/react-router';
import { Download, RotateCcw, Trophy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { GameSocket } from '../../game-client';
import { BackToLobbyButton } from '../../room-components';
import { EscapeFinaleView } from '../escape-finale';
import { formatDelta } from '../escape-reducer';
import type { EscapeHostUi } from './host-reducer';
import { type ResultsCsvLabels, resultsCsv, resultsFilename } from './results-csv';

/**
 * The run's results for the host (M5 Task 5.15): the ranking and awards the teams
 * see, plus what the host changed (extra time, locks opened by the host, paid hints),
 * a CSV of it all (no answers: the finale holds none), and what comes next: the
 * finale again, back to the lobby, or the same room again. Once the room has closed
 * it is read-only: the CSV, and a way back to the escape rooms.
 */

export interface ResultsCommands {
  pending: EscapeHostUi['pending'];
  finale: () => Promise<unknown>;
  runAgain: () => Promise<unknown>;
}

function useCsvLabels(): ResultsCsvLabels {
  const { t } = useTranslation('escape');
  return {
    place: t('host.results.csv.place'),
    team: t('host.results.csv.team'),
    escaped: t('host.results.csv.escaped'),
    score: t('host.results.csv.score'),
    stagesCleared: t('host.results.csv.stagesCleared'),
    stage: (n) => t('host.results.csv.stage', { n }),
    hints: t('host.results.csv.hints'),
    paidHints: t('host.results.csv.paidHints'),
    penaltyS: t('host.results.csv.penaltyS'),
    extraS: t('host.results.csv.extraS'),
    hostUnlocks: t('host.results.csv.hostUnlocks'),
    members: t('host.results.csv.members'),
    yes: t('host.results.csv.yes'),
    no: t('host.results.csv.no'),
  };
}

/** What the host did to each team, beside the ranking. */
function HostColumns({ finale }: { finale: EscapeFinale }) {
  const { t } = useTranslation('escape');
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 py-2 text-left font-medium">
          {t('host.results.hostColumns')}
        </caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('host.results.col.team')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('host.results.col.hints')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('host.results.col.penalty')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('host.results.col.extra')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('host.results.col.unlocks')}
            </th>
          </tr>
        </thead>
        <tbody>
          {finale.ranking.map((r) => (
            <tr key={r.teamId} data-team={r.teamId} className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-medium break-words">
                {r.name}
              </th>
              <td className="px-3 py-2 tabular-nums">
                {t('host.results.hints', { total: r.hintsUsed, paid: r.paidHints })}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {r.hintPenaltyS > 0 ? formatDelta(r.hintPenaltyS * 1000) : '—'}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {r.adjustMs !== 0
                  ? t('host.results.extra', { delta: formatDelta(r.adjustMs) })
                  : '—'}
              </td>
              <td className="px-3 py-2 tabular-nums">{r.hostUnlocks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HostResults({
  finale,
  closed,
  pin,
  socket,
  stageCount,
  commands,
  lost = false,
}: {
  finale: EscapeFinale;
  /** The room has closed (`ended: 'final'`): read-only. */
  closed: boolean;
  /** The connection is down: the room commands are off, the CSV (local) stays on. */
  lost?: boolean;
  pin: string;
  socket: GameSocket | null;
  /** The template's stage count: a column per stage in the CSV. */
  stageCount: number;
  commands: ResultsCommands;
}) {
  const { t } = useTranslation('escape');
  const labels = useCsvLabels();
  const [error, setError] = useState<string | null>(null);
  const [againFailed, setAgainFailed] = useState(false);

  const download = () =>
    downloadCsv(resultsFilename(finale.title), resultsCsv(finale, labels, stageCount));
  const run = async (send: () => Promise<unknown>, again = false) => {
    setError(null);
    setAgainFailed(false);
    try {
      await send();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAgainFailed(again);
    }
  };

  return (
    <section aria-labelledby="escape-results" className="flex flex-col gap-5">
      <h2 id="escape-results" className="sr-only">
        {t('host.results.title')}
      </h2>
      <EscapeFinaleView finale={finale} myTeamId={null} closed={false} />
      <HostColumns finale={finale} />
      <div className="flex flex-wrap items-start gap-2">
        <Button type="button" variant="outline" className="min-h-12" onClick={download}>
          <Download className="size-4" aria-hidden />
          {t('host.results.download')}
        </Button>
        {closed ? null : (
          <fieldset disabled={lost} className="contents">
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              disabled={!!commands.pending.finale}
              aria-busy={!!commands.pending.finale}
              onClick={() => void run(commands.finale)}
            >
              <Trophy className="size-4" aria-hidden />
              {t('host.results.finaleAgain')}
            </Button>
            <BackToLobbyButton pin={pin} socket={socket} mode="podium" offerArchive={false} />
            <Button
              type="button"
              variant="main-action"
              className="min-h-12"
              disabled={!!commands.pending.runAgain}
              aria-busy={!!commands.pending.runAgain}
              onClick={() => void run(commands.runAgain, true)}
            >
              <RotateCcw className="size-4" aria-hidden />
              {t('host.results.runAgain')}
            </Button>
          </fieldset>
        )}
      </div>
      {error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
          {againFailed ? (
            <Link to="/escape" className="text-sm underline">
              {t('host.results.pickAnother')}
            </Link>
          ) : null}
        </div>
      ) : null}
      {closed ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground">{t('host.results.closed')}</p>
          <Link to="/escape" className={cn(buttonVariants({ variant: 'outline' }), 'min-h-12')}>
            {t('host.results.pickAnother')}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
