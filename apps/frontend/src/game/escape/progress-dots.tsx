import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Where the team is in the run: one dot per stage, the ones behind filled, the current one ringed. */
export function ProgressDots({
  stageIndex,
  stageCount,
}: {
  stageIndex: number;
  stageCount: number;
}) {
  const { t } = useTranslation('escape');
  return (
    <ol
      aria-label={t('progress.label', { current: stageIndex + 1, total: stageCount })}
      className="flex items-center gap-1.5"
    >
      {Array.from({ length: stageCount }, (_, i) => (
        <li
          key={i}
          aria-current={i === stageIndex ? 'step' : undefined}
          className={cn(
            'size-2.5 rounded-full',
            i < stageIndex && 'bg-primary',
            i === stageIndex &&
              'bg-primary ring-primary/40 ring-offset-background ring-2 ring-offset-1',
            i > stageIndex && 'bg-muted-foreground/30',
          )}
        />
      ))}
    </ol>
  );
}
