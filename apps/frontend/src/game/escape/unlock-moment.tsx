import { motion } from 'motion/react';
import { DoorOpen, PartyPopper } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../motion/level';
import type { Overlay } from './escape-reducer';

/** How long the moment stays before it closes by itself. */
export const UNLOCK_MS = 2500;

/** The DOM id of the stage's title (or the escaped screen's): focus lands there after the moment. */
export const STAGE_TITLE_ID = 'escape-stage-title';

const VIBRATION = [80, 40, 120];

/**
 * The moment a stage opens, or the team escapes: the stage's unlock text over the
 * page, a short vibration, gone after 2.5 s or on a tap. One at a time: a new one
 * replaces the last. It says nothing itself; the page's announcer does.
 */
export function UnlockMoment({
  overlay,
  onClose,
}: {
  overlay: Overlay | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('escape');
  const level = useMotionLevel();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!overlay) return;
    if ('vibrate' in navigator) navigator.vibrate?.(VIBRATION);
    const id = setTimeout(() => closeRef.current(), UNLOCK_MS);
    return () => clearTimeout(id);
  }, [overlay]);

  // Once closed, the player goes on from the new stage's title.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (overlay) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      document.getElementById(STAGE_TITLE_ID)?.focus();
    }
  }, [overlay]);

  if (!overlay) return null;
  const escaped = overlay.kind === 'escaped';
  const Icon = escaped ? PartyPopper : DoorOpen;
  const body = (
    <>
      <Icon aria-hidden className="text-primary size-14" />
      <p className="text-2xl font-bold">
        {escaped ? t('unlock.escaped') : t('unlock.stage', { number: overlay.stageIndex + 2 })}
      </p>
      {overlay.unlockText && (
        <p className="text-muted-foreground max-w-[22em] text-lg whitespace-pre-line">
          {overlay.unlockText}
        </p>
      )}
      <span className="text-muted-foreground mt-4 text-sm">{t('unlock.tap')}</span>
    </>
  );
  const shared = {
    'data-testid': 'unlock-moment',
    'data-motion': level,
    onClick: () => onClose(),
    className: cn(
      'bg-background/95 fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center gap-3 px-6 text-center',
    ),
  };
  // Hidden from screen readers: the announcer already says the same words.
  if (level === 'none') {
    return (
      <div {...shared} aria-hidden>
        {body}
      </div>
    );
  }
  return (
    <motion.div
      // A fresh overlay plays again; it never stacks on the last one.
      key={`${overlay.kind}:${overlay.kind === 'stage' ? overlay.stageIndex : ''}:${overlay.unlockText}`}
      {...shared}
      aria-hidden
      initial={level === 'full' ? { opacity: 0, scale: 0.92 } : { opacity: 0 }}
      animate={level === 'full' ? { opacity: 1, scale: 1 } : { opacity: 1 }}
      transition={{ duration: level === 'full' ? 0.35 : 0.2 }}
    >
      {body}
    </motion.div>
  );
}
