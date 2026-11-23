import type { EscapeBrand } from '@quiz-dock/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * A hosted event's brand (M7 §1.9): the customer's logo as given and its name; on
 * the screen lobby, its intro too. A logo that fails to load goes, the name stays.
 * Sized by the caller's text: `size` scales the logo with the band.
 */
export function BrandBand({
  brand,
  intro = false,
  className,
  logoClassName,
}: {
  brand: EscapeBrand | null;
  /** The screen lobby: the brand's intro under its name. */
  intro?: boolean;
  className?: string;
  /** The logo's height (at most a fifth of the band on the screen). */
  logoClassName?: string;
}) {
  const { t } = useTranslation('escape');
  const [broken, setBroken] = useState<string | null>(null);
  if (!brand) return null;
  const logo = brand.logoUrl && broken !== brand.logoUrl ? brand.logoUrl : null;
  return (
    <div data-brand className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {logo ? (
          <img
            src={logo}
            alt={t('brand.logo', { name: brand.name })}
            className={cn('h-8 w-auto max-w-[40%] shrink-0 object-contain', logoClassName)}
            referrerPolicy="no-referrer"
            onError={() => setBroken(logo)}
          />
        ) : null}
        <span className="truncate font-semibold">{brand.name}</span>
      </div>
      {intro && brand.intro ? <p className="whitespace-pre-line">{brand.intro}</p> : null}
    </div>
  );
}
