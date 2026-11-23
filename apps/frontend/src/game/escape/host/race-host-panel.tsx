import type { EscapeHostSession, EscapeHostState } from '@quiz-dock/contracts';
import { Copy, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { joinBase } from '../../join-url';
import type { GameView } from '../../use-game-session';
import { RaceCountdown } from '../session/race-countdown';

/** The public race board (M7 §1.7): the invitation's origin, then `/race/<pin>`. */
export function raceBoardUrl(view: Pick<GameView, 'joinBaseUrl'>, pin: string): string {
  return `${joinBase(view)}/race/${pin}`;
}

/** The board's address and a copy button: anyone with it can watch (a stream, say). */
export function RaceBoardLink({ pin, view }: { pin: string; view: Pick<GameView, 'joinBaseUrl'> }) {
  const { t } = useTranslation('escape');
  const [note, setNote] = useState<string | null>(null);
  const url = raceBoardUrl(view, pin);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setNote(t('race.console.copied'));
    } catch {
      // No clipboard (plain http on a local network): the address to copy by hand.
      setNote(t('race.console.copyByHand', { url }));
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{t('race.console.board')}</span>
      <div className="flex flex-wrap items-center gap-2">
        <a href={url} target="_blank" rel="noreferrer" className="text-sm break-all underline">
          {url}
        </a>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy()}>
          <Copy className="size-4" aria-hidden />
          {t('race.console.copy')}
        </Button>
      </div>
      <span className="text-muted-foreground text-xs">{t('race.console.boardHint')}</span>
      {note ? (
        <p role="status" className="text-muted-foreground text-sm">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A race's lobby on the console (M7 Task 7.15), in place of the formation panel and
 * the team board: the format, how many have joined, the countdown to a scheduled
 * start (or "you start it"), "Start now" after a confirm, and the public board link.
 * Teams form on the phones (solo, or by code); the host moves nobody.
 */
export function RaceHostPanel({
  pin,
  session,
  host,
  view,
  onStart,
  starting,
}: {
  pin: string;
  session: EscapeHostSession;
  host: Pick<EscapeHostState, 'teams'>;
  view: Pick<GameView, 'joinBaseUrl'>;
  onStart: () => Promise<unknown>;
  starting: boolean;
}) {
  const { t } = useTranslation('escape');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const race = session.race;
  const scheduled = race?.startsAt != null && !race.started;
  const start = async () => {
    setAsking(false);
    setError(null);
    try {
      await onStart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section aria-labelledby="escape-race" className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 id="escape-race" className="text-lg font-semibold">
        {t('race.console.title')}
      </h2>
      <p className="text-sm">
        {t(race?.format === 'teams' ? 'race.console.teams' : 'race.console.solo')}
      </p>
      <p className="text-sm tabular-nums">
        {t('race.console.counts', { teams: host.teams.length, players: session.joined })}
      </p>
      {scheduled && race?.startsAt != null ? (
        <RaceCountdown startsAt={race.startsAt} className="text-2xl" />
      ) : (
        <p className="text-muted-foreground text-sm">{t('race.console.byHost')}</p>
      )}
      <Button
        type="button"
        variant="main-action"
        size="lg"
        className="min-h-12 self-start"
        disabled={starting || session.joined === 0}
        aria-busy={starting}
        onClick={() => setAsking(true)}
      >
        <Play className="size-4" aria-hidden />
        {t('race.console.startNow')}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <RaceBoardLink pin={pin} view={view} />
      <ConfirmDialog
        open={asking}
        title={t('race.console.startTitle')}
        description={
          scheduled
            ? `${t('race.console.startDescription')} ${t('race.console.startScheduled')}`
            : t('race.console.startDescription')
        }
        confirmLabel={t('race.console.startConfirm')}
        onConfirm={() => void start()}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}
