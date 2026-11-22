import { useTranslation } from 'react-i18next';
import { PageTitle } from '@/components/ui/page-title';
import type { useGameSession } from '../game/use-game-session';

/** The escape host console (M5): a stub for the console seam, composed by phase in Task 5.16. */
export function EscapeConsole({
  pin,
}: {
  pin: string;
  session: ReturnType<typeof useGameSession>;
}) {
  const { t } = useTranslation('escape');
  return <PageTitle data-pin={pin}>{t('host.console')}</PageTitle>;
}
