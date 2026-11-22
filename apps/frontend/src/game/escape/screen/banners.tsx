import { CircleCheck, DoorOpen, Hourglass, Lightbulb } from 'lucide-react';
import { motion as m } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';
import { EscapeAnnouncer } from '../escape-announcer';
import type { Banner, EscapeScreenUi } from './screen-reducer';

const ICON = {
  escaped: DoorOpen,
  'stage-cleared': CircleCheck,
  hint: Lightbulb,
  'time-up': Hourglass,
} as const;

/**
 * Unlock and hint banners (M6 Task 6.9): the reducer's current banner, one at a time,
 * in a slot of its own above the race (never over the show clock), each said once to
 * a screen reader through the polite region. No hint or unlock text: a team name, a
 * stage and its title once a team reached it. While the run is paused none shows.
 */
export function ScreenBanners({
  ui,
}: {
  ui: Pick<EscapeScreenUi, 'current' | 'stageTitles' | 'polite' | 'board'>;
}) {
  const paused = ui.board?.clock.paused ?? false;
  const current = paused ? null : ui.current;
  return (
    <div
      data-testid="banner-slot"
      className="flex min-h-[3.6em] shrink-0 items-center justify-center"
    >
      {current && <BannerView key={current.id} banner={current} titles={ui.stageTitles} />}
      <EscapeAnnouncer polite={ui.polite} assertive={null} />
    </div>
  );
}

function BannerView({ banner, titles }: { banner: Banner; titles: Record<number, string> }) {
  const { t } = useTranslation('escape');
  const level = useMotionLevel();
  const large = banner.kind === 'escaped';
  const title = titles[banner.stageIndex];
  const params = { team: banner.teamName, stage: banner.stageIndex + 1, title };
  const text =
    banner.kind === 'stage-cleared' && title
      ? t('screen.banner.stageClearedTitled', params)
      : t(
          {
            escaped: 'screen.banner.escaped',
            'stage-cleared': 'screen.banner.stageCleared',
            hint: 'screen.banner.hint',
            'time-up': 'screen.banner.timeUp',
          }[banner.kind],
          params,
        );
  const Icon = ICON[banner.kind];
  const className = cn(
    'flex max-w-full items-center gap-[0.5em] rounded-[0.6em] px-[1em] py-[0.3em] font-bold shadow-lg',
    large
      ? 'bg-primary text-primary-foreground text-[2.4em]'
      : 'bg-card text-card-foreground border-[0.08em] text-[1.6em]',
  );
  const body = (
    <>
      <Icon aria-hidden className="size-[1.1em] shrink-0" />
      {/* The polite region says it; this copy is for the room. */}
      <span aria-hidden className="truncate">
        {text}
      </span>
    </>
  );
  const props = {
    'data-testid': 'screen-banner',
    'data-motion': level,
    'data-size': large ? 'large' : undefined,
    className,
  };
  if (level === 'none') return <div {...props}>{body}</div>;
  return (
    <m.div
      {...props}
      initial={level === 'full' ? { opacity: 0, y: '-0.6em' } : { opacity: 0 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: level === 'full' ? 0.35 : 0.2 }}
    >
      {body}
    </m.div>
  );
}
