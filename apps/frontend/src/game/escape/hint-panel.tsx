import type { EscapeAskHintAck, EscapePlayerState } from '@quiz-dock/contracts';
import { Lightbulb } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatDelta } from './escape-reducer';

/**
 * The team's hints: the ones released so far (newest first), what they cost the team
 * in all, and a Hint button that says the next one's cost and asks before sending.
 * Timed and host hints arrive on their own: they show with the next state.
 */
export function HintPanel({
  state,
  hintTags,
  canPlay,
  askHint,
}: {
  state: EscapePlayerState;
  /** `EscapeUi.hintTags`: free or paid, when the update that brought the hint said so. */
  hintTags: Record<string, 'free' | 'paid'>;
  /** Not offline, paused, timed out or escaped (§1.7). */
  canPlay: boolean;
  askHint: (hintId: string) => Promise<EscapeAskHintAck>;
}) {
  const { t } = useTranslation('escape');
  const headingId = useId();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Set before the re-render: a second tap on Confirm in the same frame sends nothing.
  const inFlight = useRef(false);
  // The hint last asked for: until a state offers the next, asking again would pay twice.
  const asked = useRef<string | null>(null);

  const hints = [...(state.view?.hints ?? [])].reverse();
  const next = state.nextHint;
  const penaltyS = state.team?.hintPenaltyS ?? 0;
  if (!hints.length && !next) return null;

  const confirm = async () => {
    if (!next || inFlight.current || asked.current === next.id) {
      if (next && asked.current === next.id) setAsking(false);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    try {
      // A refusal (a teammate took it first: `no-hint`) closes too; the announcer says why.
      await askHint(next.id);
      asked.current = next.id;
      setAsking(false);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const cost = next?.penaltyS ? t('hints.cost', { seconds: next.penaltyS }) : t('hints.free');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-semibold">
          {t('hints.title')}
        </h2>
        {penaltyS > 0 && (
          <span className="text-muted-foreground text-sm tabular-nums">
            {t('hints.total', { delta: formatDelta(penaltyS * 1000) })}
          </span>
        )}
      </div>
      {hints.length > 0 && (
        <ul className="flex flex-col gap-2">
          {hints.map((h) => (
            <li key={h.id} className="bg-card flex flex-col gap-1.5 rounded-lg border p-3">
              {hintTags[h.id] && (
                <span className="bg-muted text-muted-foreground self-start rounded-full px-2 py-0.5 text-xs font-medium">
                  {t(hintTags[h.id] === 'free' ? 'hints.tagFree' : 'hints.tagPaid')}
                </span>
              )}
              <p className="whitespace-pre-line">{h.text}</p>
            </li>
          ))}
        </ul>
      )}
      {next && canPlay && (
        <div className="bg-background/95 sticky bottom-0 py-2">
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="min-h-12 w-full"
            onClick={() => {
              setFailed(false);
              setAsking(true);
            }}
          >
            <Lightbulb aria-hidden className="size-4" />
            {t('hints.ask', { cost })}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={asking && !!next}
        title={t('hints.confirmTitle')}
        description={
          next?.penaltyS
            ? t('hints.confirmCost', { seconds: next.penaltyS })
            : t('hints.confirmFree')
        }
        confirmLabel={t('hints.confirm')}
        confirmDisabled={pending}
        onCancel={() => setAsking(false)}
        onConfirm={() => void confirm()}
      >
        {failed && <p className="text-destructive text-sm">{t('lock.sendFailed')}</p>}
      </ConfirmDialog>
    </section>
  );
}
