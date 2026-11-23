import type { EscapePlayerState } from '@quiz-dock/contracts';
import { Link } from '@tanstack/react-router';
import { Flag, Lightbulb, MonitorCog, Pause, Play, Trophy } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import type { HostEvent, HostPayload } from '../host/host-client';
import type { PhoneHostRoom } from '../host/use-phone-host';

type Send = <E extends HostEvent>(event: E, payload: HostPayload<E>) => Promise<unknown>;

/** Tap targets of at least 48 px (M4 rule). */
const TAP = 'min-h-12';

/**
 * Group play's host controls on the phone that hosts and plays (M7 owner question 1):
 * a sticky footer, in the page's flow so it never covers the lock inputs. Lobby:
 * Start (once someone is in a team), the seats and "Open console". Running: Pause or
 * Resume, a hint for this phone's own team (its cost first) and End (confirmed).
 * Finale: show it again. Only counts and the phone's own team: no other team's details.
 */
export function PhoneHostBar({
  pin,
  state,
  room,
  send,
}: {
  pin: string;
  state: EscapePlayerState;
  /** From the host state; null until it came. */
  room: PhoneHostRoom | null;
  send: Send;
}) {
  const { t } = useTranslation('escape');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'hint' | 'end' | null>(null);
  const busyRef = useRef(false);

  const run = async (go: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await go();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const team = state.team;
  const hint = state.nextHint;
  const paused = state.clock.paused;
  const playing = !!team && !team.escaped && !team.timedOut;

  let controls: React.ReactNode;
  if (state.phase === 'forming') {
    controls = (
      <>
        <Button
          type="button"
          variant="main-action"
          className={TAP}
          disabled={busy || !room?.ready}
          aria-busy={busy}
          onClick={() => void run(() => send('escape:start', { pin }))}
        >
          <Play className="size-4" aria-hidden />
          {t('session.hostBar.start')}
        </Button>
        {room ? (
          <span
            className="text-sm font-medium tabular-nums"
            aria-label={t('session.console.seatsLabel', { joined: room.joined, cap: room.cap })}
          >
            {t('session.console.seats', { joined: room.joined, cap: room.cap })}
          </span>
        ) : null}
      </>
    );
  } else if (state.phase === 'running') {
    controls = (
      <>
        <Button
          type="button"
          variant={paused ? 'main-action' : 'outline'}
          className={TAP}
          disabled={busy}
          aria-busy={busy}
          onClick={() => void run(() => send('escape:pause', { pin, paused: !paused }))}
        >
          {paused ? (
            <Play className="size-4" aria-hidden />
          ) : (
            <Pause className="size-4" aria-hidden />
          )}
          {paused ? t('session.hostBar.resume') : t('session.hostBar.pause')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={TAP}
          disabled={busy || !playing || !hint}
          onClick={() => setAsking('hint')}
        >
          <Lightbulb className="size-4" aria-hidden />
          {t('session.hostBar.hint')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className={TAP}
          disabled={busy}
          onClick={() => setAsking('end')}
        >
          <Flag className="size-4" aria-hidden />
          {t('session.hostBar.end')}
        </Button>
      </>
    );
  } else {
    controls = (
      <Button
        type="button"
        variant="outline"
        className={TAP}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void run(() => send('escape:finale', { pin }))}
      >
        <Trophy className="size-4" aria-hidden />
        {t('session.hostBar.finaleAgain')}
      </Button>
    );
  }

  return (
    <section
      aria-label={t('session.hostBar.label')}
      data-phone-host-bar
      className="bg-background/95 sticky bottom-0 z-10 -mx-4 mt-auto flex flex-col gap-2 border-t px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <Link
          to="/session/$pin/console"
          params={{ pin }}
          className={cn(buttonVariants({ variant: 'ghost' }), TAP, 'ml-auto')}
        >
          <MonitorCog className="size-4" aria-hidden />
          {t('session.hostBar.openConsole')}
        </Link>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={asking === 'hint'}
        title={t('session.hostBar.hintTitle')}
        description={t('session.hostBar.hintCost', { seconds: hint?.penaltyS ?? 0 })}
        confirmLabel={t('session.hostBar.hintConfirm')}
        onConfirm={() => {
          setAsking(null);
          if (team && hint)
            void run(() => send('escape:hint', { pin, teamId: team.id, hintId: hint.id }));
        }}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking === 'end'}
        title={t('session.hostBar.endTitle')}
        description={t('session.hostBar.endDescription')}
        confirmLabel={t('session.hostBar.endConfirm')}
        destructive
        onConfirm={() => {
          setAsking(null);
          void run(() => send('escape:end', { pin }));
        }}
        onCancel={() => setAsking(null)}
      />
    </section>
  );
}
