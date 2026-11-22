import type { EscapePlayerState, EscapePlayerView } from '@quiz-dock/contracts';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceLock } from './choice-lock';
import { CodeLock } from './code-lock';
import { CombinedLock } from './combined-lock';
import { type LockBlock, LockCard, lockTitleId, type SubmitLock } from './lock-card';
import { PhraseLock } from './phrase-lock';
import { SequenceLock } from './sequence-lock';

/** What keeps the whole team from trying a lock right now, if anything (§1.7). */
export function blockOf(state: EscapePlayerState, connectionLost: boolean): LockBlock {
  if (connectionLost) return 'offline';
  if (state.team?.timedOut) return 'time-up';
  if (state.clock.paused) return 'paused';
  if (state.team?.escaped || state.view?.escaped) return 'escaped';
  return null;
}

/**
 * The stage's locks, all open at once and in any order (parallel play; a roles stage
 * is drawn the same way). Solved ones fold to a line; after a solve of mine, focus
 * moves on to the next lock still closed.
 */
export function LockList({
  view,
  roles,
  block,
  submit,
}: {
  view: EscapePlayerView;
  roles: EscapePlayerState['roles'];
  block: LockBlock;
  submit: SubmitLock;
}) {
  const { t } = useTranslation('escape');
  // The lock I just opened: once the state shows it solved, focus goes to the next one.
  const solvedByMe = useRef<string | null>(null);
  const tryLock: SubmitLock = async (lockId, input, roleId) => {
    const ack = await (roleId ? submit(lockId, input, roleId) : submit(lockId, input));
    // A cleared stage moves focus itself (the unlock moment).
    if (ack.ok && ack.outcome === 'lock-solved') solvedByMe.current = lockId;
    return ack;
  };

  const { locks } = view;
  useEffect(() => {
    const id = solvedByMe.current;
    if (!id || !locks.find((l) => l.id === id)?.solved) return;
    solvedByMe.current = null;
    const at = locks.findIndex((l) => l.id === id);
    const next = [...locks.slice(at + 1), ...locks.slice(0, at)].find((l) => !l.solved);
    if (next) document.getElementById(lockTitleId(next.id))?.focus();
  }, [locks]);

  const open = locks.filter((l) => l.solved).length;
  return (
    <section className="flex flex-col gap-3">
      {locks.length > 1 && (
        <p className="text-muted-foreground text-sm font-medium">
          {t('locks.open', { done: open, count: locks.length })}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {locks.map((l) => (
          <li key={l.id}>
            {l.solved ? (
              <LockCard lock={l}>{null}</LockCard>
            ) : l.kind === 'code' ? (
              <CodeLock lock={l} block={block} submit={tryLock} />
            ) : l.kind === 'phrase' ? (
              <PhraseLock lock={l} block={block} submit={tryLock} />
            ) : l.kind === 'choice' ? (
              <ChoiceLock lock={l} block={block} submit={tryLock} />
            ) : l.kind === 'sequence' ? (
              <SequenceLock lock={l} block={block} submit={tryLock} />
            ) : (
              <CombinedLock lock={l} block={block} submit={tryLock} roles={roles} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
