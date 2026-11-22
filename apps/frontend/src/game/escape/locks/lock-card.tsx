import type { EscapePlayerLockView, EscapeSubmitAck } from '@quiz-dock/contracts';
import { useAnimate } from 'motion/react';
import {
  Check,
  KeyRound,
  ListChecks,
  ListOrdered,
  Loader2,
  type LucideIcon,
  Type,
  Users,
} from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';

/** Why the run, not the lock, keeps the player from trying: nothing is queued meanwhile (§1.7). */
export type LockBlock = 'offline' | 'paused' | 'time-up' | 'escaped' | null;

/** `useEscapeSession().submit`: a rules refusal resolves, a failed send rejects. */
export type SubmitLock = (
  lockId: string,
  input: string | string[],
  roleId?: string,
) => Promise<EscapeSubmitAck>;

/** What every kind of lock is drawn from. */
export interface LockProps {
  lock: EscapePlayerLockView;
  block: LockBlock;
  submit: SubmitLock;
}

const KIND_ICON: Record<EscapePlayerLockView['kind'], LucideIcon> = {
  code: KeyRound,
  phrase: Type,
  choice: ListChecks,
  sequence: ListOrdered,
  combined: Users,
};

/** The DOM id of a lock's title: the lock list moves focus there. */
export const lockTitleId = (lockId: string) => `escape-lock-${lockId}`;

/** A lock's frame: its title and kind, then its input, or "Opened" once solved. */
export function LockCard({ lock, children }: { lock: EscapePlayerLockView; children: ReactNode }) {
  const { t } = useTranslation('escape');
  const Icon = KIND_ICON[lock.kind];
  return (
    <article
      data-solved={lock.solved || undefined}
      className={cn(
        'bg-card flex flex-col gap-3 rounded-lg border p-4',
        lock.solved && 'border-success/40 bg-success/5',
      )}
    >
      <h3
        id={lockTitleId(lock.id)}
        tabIndex={-1}
        className="flex items-center gap-2 font-semibold focus-visible:outline-none"
      >
        <Icon aria-hidden className="text-muted-foreground size-5 shrink-0" />
        <span className="min-w-0 flex-1">{lock.label}</span>
        <span className="text-muted-foreground text-xs font-normal">
          {t(`lock.kind.${lock.kind}`)}
        </span>
      </h3>
      {lock.solved ? (
        <p className="text-success flex items-center gap-2 font-medium">
          <Check aria-hidden className="size-5" />
          {t('lock.opened')}
        </p>
      ) : (
        children
      )}
    </article>
  );
}

type Feedback =
  | { kind: 'wrong' }
  | { kind: 'refused'; key: string }
  | { kind: 'stuck'; key: string }
  | { kind: 'wait'; until: number }
  | null;

/** Refusals that stay until the run changes (a new state): trying again cannot help. */
const STUCK: Record<string, string> = {
  paused: 'lock.paused',
  'time-up': 'lock.timeUp',
  'not-running': 'lock.notRunning',
  escaped: 'lock.notRunning',
};
const REFUSED: Record<string, string> = {
  'not-your-part': 'lock.notYourPart',
  'already-solved': 'lock.alreadySolved',
};
const BLOCKED: Partial<Record<NonNullable<LockBlock>, string>> = {
  paused: 'lock.paused',
  'time-up': 'lock.timeUp',
};

/**
 * One answer to send: the input (children), its feedback and a large submit button.
 * A submit in flight blocks the next one, so a double tap sends once. A wrong answer
 * shakes the input and leaves the draft selected; a rate limit counts down.
 */
export function LockForm({
  lock,
  block,
  ready,
  send,
  children,
}: {
  /** A new lock object (a new state) lifts a refusal that waited for the run to change. */
  lock: EscapePlayerLockView;
  block: LockBlock;
  /** Something to send: the button stays off until then. */
  ready: boolean;
  send: () => Promise<EscapeSubmitAck>;
  /** The input; after a wrong answer its text field (selected) or its `tabIndex={-1}` group gets focus. */
  children: (disabled: boolean) => ReactNode;
}) {
  const { t } = useTranslation('escape');
  const level = useMotionLevel();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Bumped on each wrong answer: the input is then focused and shaken, once enabled again.
  const [wrongs, setWrongs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Set before the re-render: a second tap in the same frame sends nothing.
  const inFlight = useRef(false);

  useEffect(() => {
    setFeedback((f) => (f?.kind === 'stuck' ? null : f));
  }, [lock]);

  const waitUntil = feedback?.kind === 'wait' ? feedback.until : null;
  useEffect(() => {
    if (waitUntil === null) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= waitUntil) setFeedback(null);
    }, 250);
    return () => clearInterval(id);
  }, [waitUntil]);

  const disabled = block !== null || feedback?.kind === 'stuck' || feedback?.kind === 'wait';

  // Before paint, in the commit that enables the input again.
  useLayoutEffect(() => {
    if (!wrongs) return;
    // The text input, else the options' group (focusable, `tabIndex={-1}`).
    const el = scope.current?.querySelector<HTMLElement>('input, [tabindex="-1"]');
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
    if (level === 'full' && scope.current) {
      void animate(scope.current, { x: [0, -10, 10, -6, 6, 0] }, { duration: 0.4 });
    }
    // Only a new wrong answer moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrongs]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || disabled || !ready) return;
    inFlight.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const ack = await send();
      if (ack.ok) {
        if (ack.outcome === 'wrong') {
          setFeedback({ kind: 'wrong' });
          setWrongs((n) => n + 1);
        }
      } else if (ack.reason === 'rate-limited') {
        const at = Date.now();
        setNow(at);
        setFeedback({ kind: 'wait', until: at + (ack.retryAfterMs ?? 1000) });
      } else if (STUCK[ack.reason]) {
        setFeedback({ kind: 'stuck', key: STUCK[ack.reason] });
      } else {
        setFeedback({ kind: 'refused', key: REFUSED[ack.reason] ?? 'lock.refused' });
      }
    } catch {
      setFeedback({ kind: 'refused', key: 'lock.sendFailed' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const blockedKey = block ? BLOCKED[block] : undefined;
  const message =
    blockedKey !== undefined
      ? t(blockedKey)
      : feedback?.kind === 'wrong'
        ? t('lock.wrong')
        : feedback?.kind === 'wait'
          ? t('lock.retryIn', { seconds: Math.max(1, Math.ceil((feedback.until - now) / 1000)) })
          : feedback
            ? t(feedback.key)
            : null;

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)} noValidate>
      <div ref={scope}>{children(disabled)}</div>
      {message && (
        <p
          className={cn(
            'text-sm',
            feedback?.kind === 'wrong' ? 'text-destructive font-medium' : 'text-muted-foreground',
          )}
        >
          {message}
        </p>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-12 w-full"
        disabled={disabled || !ready}
        aria-busy={pending || undefined}
      >
        {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
        {t('lock.submit')}
      </Button>
    </form>
  );
}
