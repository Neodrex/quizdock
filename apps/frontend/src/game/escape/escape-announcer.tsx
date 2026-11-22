import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Announcement } from './escape-reducer';

/** How long each polite message stays in its region, at least, before the next. */
export const SAY_MS = 1000;

interface Queue {
  current: Announcement | null;
  waiting: Announcement[];
}
type QueueAction = { type: 'add'; fresh: Announcement[] } | { type: 'next' };

function queueReducer(q: Queue, a: QueueAction): Queue {
  if (a.type === 'add') {
    const all = [...q.waiting, ...a.fresh];
    return q.current ? { ...q, waiting: all } : { current: all[0] ?? null, waiting: all.slice(1) };
  }
  return { current: q.waiting[0] ?? null, waiting: q.waiting.slice(1) };
}

/**
 * What a screen reader hears of the run. Two regions, mounted from the start (a region
 * that appears with its text is often not read): a polite one for unlocks, hints and
 * time changes, said one at a time so none cuts another short, and an assertive one
 * for the timer warnings only. Each message is its own node, so the same words said
 * twice are read twice.
 */
export function EscapeAnnouncer({
  polite,
  assertive,
}: {
  polite: Announcement[];
  assertive: Announcement | null;
}) {
  const { t } = useTranslation('escape');
  const [{ current }, dispatch] = useReducer(queueReducer, { current: null, waiting: [] });
  // The last message id taken into the queue: the reducer keeps the ones already said.
  const seenRef = useRef(0);

  useEffect(() => {
    const fresh = polite.filter((m) => m.id > seenRef.current);
    if (!fresh.length) return;
    seenRef.current = fresh[fresh.length - 1].id;
    dispatch({ type: 'add', fresh });
  }, [polite]);

  useEffect(() => {
    if (!current) return;
    const id = setTimeout(() => dispatch({ type: 'next' }), SAY_MS);
    return () => clearTimeout(id);
  }, [current]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {current && <span key={current.id}>{t(current.key, current.params)}</span>}
      </div>
      <div
        className="sr-only"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="escape-assertive"
      >
        {assertive && <span key={assertive.id}>{t(assertive.key, assertive.params)}</span>}
      </div>
    </>
  );
}
